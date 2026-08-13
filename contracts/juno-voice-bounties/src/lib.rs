pub mod contract;
pub mod error;
pub mod msg;
pub mod state;

#[cfg(test)]
mod tests;

#[cfg(not(feature = "library"))]
pub use crate::contract::{execute, instantiate, query, reply};
