use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    InvalidInput,
    Unavailable,
    Refused,
    Failed,
    Indeterminate,
    TransportFailure,
}

impl Outcome {
    pub const fn exit_code(self) -> i32 {
        match self {
            Self::Success => 0,
            Self::InvalidInput => 2,
            Self::Unavailable => 3,
            Self::Refused => 4,
            Self::Failed => 5,
            Self::Indeterminate => 6,
            Self::TransportFailure => 7,
        }
    }
}
