use cosmwasm_std::{OverflowError, StdError};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),
    #[error("arithmetic overflow or underflow: {0}")]
    Overflow(#[from] OverflowError),
    #[error("unauthorized")]
    Unauthorized,
    #[error("this message does not accept funds")]
    UnexpectedFunds,
    #[error("invalid attached native funds")]
    InvalidFunds,
    #[error("invalid configuration: {0}")]
    InvalidConfiguration(String),
    #[error("invalid metadata: {0}")]
    InvalidMetadata(String),
    #[error("bounty not found")]
    NotFound,
    #[error("invalid bounty state")]
    InvalidState,
    #[error("new economic activity is paused")]
    Paused,
    #[error("bounty has expired")]
    Expired,
    #[error("bounty has not expired")]
    NotExpired,
    #[error("contributor or bounty amount limit reached")]
    ContributionLimit,
    #[error("nomination round limit reached")]
    RoundLimit,
    #[error("message refers to the wrong nomination round")]
    WrongRound,
    #[error("sender is not a contributor with positive snapshotted weight")]
    NotContributor,
    #[error("voting is closed")]
    VotingClosed,
    #[error("the full ratification window is still open")]
    RatificationOpen,
    #[error("refund already claimed")]
    AlreadyClaimed,
    #[error("bounty is not refundable")]
    NotRefundable,
    #[error("bounty is not a project candidate")]
    NotProjectCandidate,
    #[error("bounty has already graduated")]
    AlreadyGraduated,
    #[error("unknown reply id {0}")]
    UnknownReply(u64),
    #[error("registry graduation submessage failed: {0}")]
    GraduationSubmessage(String),
    #[error("there is no pending registry graduation")]
    NoPendingGraduation,
    #[error("registry returned a malformed graduation response")]
    MalformedGraduationResponse,
}
