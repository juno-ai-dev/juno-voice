pub mod bindings;
pub mod contract;
pub mod error;
pub mod msg;
pub mod state;

#[cfg(test)]
#[path = "tests/bindings.rs"]
mod bindings_tests;

#[cfg(test)]
#[path = "tests/instantiate.rs"]
mod instantiate_tests;

#[cfg(test)]
#[path = "tests/governor.rs"]
mod governor_tests;

#[cfg(test)]
#[path = "tests/audit.rs"]
mod audit_tests;
