// Adapter for the fork's `/chromevox/mv3/third_party/messageformat/messageformat.rollup.js`
// import — a Chromium BUILD ARTIFACT (rolled up from the MIT `messageformat`
// library at build time; absent from every source subtree). Same library,
// via npm @messageformat/core, adapted to the v2-style API the fork calls:
//   new MessageFormat(locale, msg).format(args, onError)
import MF from '@messageformat/core';
export class MessageFormat {
  constructor(locale, message) {
    try { this.fn_ = new MF(locale || 'en').compile(message); }
    catch (e) { this.err_ = e; this.msg_ = message; }
  }
  format(args, onError) {
    if (this.err_) { if (onError) onError(this.err_); return this.msg_ ?? ''; }
    try { return this.fn_(args || {}); }
    catch (e) { if (onError) onError(e); return this.msg_ ?? ''; }
  }
}
