use cosmwasm_std::StdError;
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("this operation must not include funds")]
    UnexpectedFunds,

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
