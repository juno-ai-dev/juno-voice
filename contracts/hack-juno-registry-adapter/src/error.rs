use cosmwasm_std::{CheckedMultiplyRatioError, DecimalRangeExceeded, OverflowError, StdError};
use thiserror::Error;

#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),
    #[error("arithmetic overflow or underflow: {0}")]
    Overflow(#[from] OverflowError),
    #[error("ratio arithmetic failed: {0}")]
    Ratio(#[from] CheckedMultiplyRatioError),
    #[error("decimal range exceeded: {0}")]
    DecimalRange(#[from] DecimalRangeExceeded),
    #[error("unauthorized")]
    Unauthorized,
    #[error("this message does not accept funds")]
    UnexpectedFunds,
    #[error("registration requires the exact configured native bond")]
    InvalidBond,
    #[error("invalid configuration: {0}")]
    InvalidConfiguration(String),
    #[error("invalid metadata: {0}")]
    InvalidMetadata(String),
    #[error("project not found")]
    NotFound,
    #[error("project id already exists")]
    DuplicateProject,
    #[error("source bounty already graduated")]
    DuplicateSourceBounty,
    #[error("project is in an invalid state for this transition")]
    InvalidState,
    #[error("active project capacity is full")]
    CapacityFull,
    #[error("admissions are stopped")]
    AdmissionsStopped,
    #[error("adapter execution is stopped")]
    AdapterStopped,
    #[error("payout address delay has not elapsed")]
    AddressDelayOpen,
    #[error("no pending payout address change")]
    NoPendingAddress,
    #[error("registration bond is not claimable")]
    BondNotClaimable,
    #[error("invalid selected allocation: {0}")]
    InvalidAllocation(String),
    #[error("wrong native denomination")]
    WrongDenom,
    #[error("epoch budget exceeds configured ceiling")]
    EpochCeilingExceeded,
}
