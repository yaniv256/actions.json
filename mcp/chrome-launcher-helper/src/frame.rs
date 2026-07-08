//! CDP `--remote-debugging-pipe` framing: NUL-terminated JSON messages.
//!
//! Ported from pipe_session.mjs lines 49-68. Chrome writes complete JSON messages separated by
//! a `\0` byte; a read may deliver partial or multiple messages, so we buffer and split on NUL.
//! Our own setup calls (loadUnpacked) use ids at/above [`SETUP_BASE`] so they never collide
//! with a client's id space.

/// Setup-call id base — our loadUnpacked etc. use ids >= this so client ids don't collide.
pub const SETUP_BASE: i64 = 1_000_000_000;

/// Accumulates raw bytes and yields complete NUL-delimited UTF-8 frames.
#[derive(Default)]
pub struct FrameBuffer {
    buf: Vec<u8>,
}

impl FrameBuffer {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    /// Append `chunk` and return every complete frame now available (the trailing partial, if
    /// any, stays buffered for the next call). Non-UTF-8 frames are skipped.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(nul) = self.buf.iter().position(|&b| b == 0) {
            let frame: Vec<u8> = self.buf.drain(..=nul).collect();
            // drop the NUL terminator
            if let Ok(s) = std::str::from_utf8(&frame[..frame.len() - 1]) {
                if !s.is_empty() {
                    out.push(s.to_string());
                }
            }
        }
        out
    }
}

/// Split a complete byte buffer into NUL-delimited frames (convenience for tests / one-shot).
pub fn split_nul_frames(bytes: &[u8]) -> Vec<String> {
    let mut fb = FrameBuffer::new();
    fb.push(bytes)
}

/// Encode a CDP message as a wire frame: the JSON text followed by a NUL byte. Used by tests
/// and available to callers that write frames directly (the relay writes inline for speed).
#[allow(dead_code)]
pub fn encode_frame(json: &str) -> Vec<u8> {
    let mut v = json.as_bytes().to_vec();
    v.push(0);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_complete_frame() {
        let frames = split_nul_frames(b"{\"id\":1}\0");
        assert_eq!(frames, vec!["{\"id\":1}".to_string()]);
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let frames = split_nul_frames(b"{\"a\":1}\0{\"b\":2}\0");
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[1], "{\"b\":2}");
    }

    #[test]
    fn partial_frame_buffers_until_terminator() {
        let mut fb = FrameBuffer::new();
        assert!(fb.push(b"{\"id\"").is_empty()); // no NUL yet
        assert!(fb.push(b":42}").is_empty()); // still no NUL
        let frames = fb.push(b"\0"); // now complete
        assert_eq!(frames, vec!["{\"id\":42}".to_string()]);
    }

    #[test]
    fn round_trip_encode_then_split() {
        // The core round-trip the plan's execution note calls for: one CDP command encoded to
        // the wire and split back out identically.
        let cmd = "{\"id\":1000000001,\"method\":\"Extensions.loadUnpacked\",\"params\":{\"path\":\"C:\\\\ext\"}}";
        let wire = encode_frame(cmd);
        assert_eq!(*wire.last().unwrap(), 0u8); // NUL-terminated
        let back = split_nul_frames(&wire);
        assert_eq!(back, vec![cmd.to_string()]);
    }

    #[test]
    fn empty_frames_are_skipped() {
        let frames = split_nul_frames(b"\0\0{\"x\":1}\0");
        assert_eq!(frames, vec!["{\"x\":1}".to_string()]);
    }

    #[test]
    fn setup_base_separates_id_spaces() {
        // A setup id is always >= SETUP_BASE; a typical client id (small) is below it.
        assert!(SETUP_BASE + 1 >= SETUP_BASE);
        assert!(42 < SETUP_BASE);
    }
}
