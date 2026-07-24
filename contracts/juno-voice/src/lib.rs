pub mod bindings;
pub mod contract;
pub mod error;
pub mod execute;
pub mod lifecycle;
pub mod msg;
mod rank;
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

#[cfg(test)]
#[path = "tests/submit_request.rs"]
mod submit_request_tests;

#[cfg(test)]
#[path = "tests/cast_vote.rs"]
mod cast_vote_tests;

#[cfg(test)]
#[path = "tests/lifecycle.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "tests/evidence_refunds.rs"]
mod evidence_refunds_tests;

#[cfg(test)]
#[path = "tests/task6_acceptance.rs"]
mod task6_acceptance_tests;
