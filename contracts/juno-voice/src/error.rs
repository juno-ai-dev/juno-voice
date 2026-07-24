use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("this operation must not include funds")]
    UnexpectedFunds,

    #[error("submission requires exactly the configured bond coin")]
    InvalidSubmissionFunds,

    #[error("request submissions are paused")]
    SubmissionsPaused,

    #[error("invalid or oversized required brief field: {field}")]
    InvalidBrief { field: &'static str },

    #[error("category must be a bounded nonempty lowercase ASCII slug")]
    InvalidCategory,

    #[error("detail URI and digest must be paired and use canonical syntax")]
    InvalidDetail,

    #[error("submission requires a nonzero execution height")]
    InvalidSnapshotHeight,

    #[error("snapshot height cannot be represented by the Juno query binding")]
    SnapshotHeightConversionOverflow,

    #[error("total voting power must be a nonzero base-10 unsigned integer")]
    InvalidTotalVotingPower,

    #[error("voter power must be a nonzero base-10 unsigned integer")]
    InvalidVotingPower,

    #[error("request {request_id} does not exist")]
    UnknownRequest { request_id: u64 },

    #[error("request is not open for voting at this height")]
    VotingNotOpen,

    #[error("voter already has an immutable receipt for this request")]
    DuplicateVote,

    #[error("snapshot total voting power differs from the immutable request total")]
    SnapshotIntegrityMismatch,

    #[error("voter power exceeds total voting power")]
    VotingPowerExceedsTotal,

    #[error("vote tally overflow")]
    VoteTallyOverflow,

    #[error("voter count overflow")]
    VoterCountOverflow,

    #[error("request id overflow")]
    RequestIdOverflow,

    #[error("locked bond total overflow")]
    BondTotalOverflow,

    #[error("invalid {role} address")]
    InvalidAddress { role: &'static str },

    #[error("invalid native denomination")]
    InvalidNativeDenom,

    #[error("submission bond must be nonzero")]
    InvalidSubmissionBond,

    #[error("voting period must be nonzero")]
    InvalidVotingPeriod,

    #[error("work inactivity period must be nonzero")]
    InvalidWorkInactivityPeriod,

    #[error("{field} must be between 1 and 10,000 bps; got {value}")]
    InvalidThreshold { field: &'static str, value: u16 },

    #[error("invalid request limits: {reason}")]
    InvalidRequestLimits { reason: &'static str },

    #[error("query limits must be nonzero and default must not exceed maximum")]
    InvalidQueryLimits,

    #[error("unsupported evidence policy version {version}; MVP requires version 1")]
    UnsupportedEvidencePolicyVersion { version: u16 },

    #[error("voting close height overflows")]
    CloseHeightOverflow,

    #[error("unauthorized")]
    Unauthorized,

    #[error("governor nominee must differ from the governor and pending nominee")]
    InvalidGovernorNominee,

    #[error("there is no pending governor")]
    NoPendingGovernor,

    #[error("reason must be nonempty after trimming and within the configured byte limit")]
    InvalidReason,

    #[error("protocol action id overflow")]
    ProtocolActionIdOverflow,
}
