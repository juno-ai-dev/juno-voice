use crate::state::Status;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Controller {
    Public,
    Steward,
    Builder,
    Verifier,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transition {
    CloseQualified,
    CloseNotPrioritized,
    MarkSpam,
    MarkDuplicate,
    StartBuilding,
    Archive,
    RequestReview,
    BlockBuilding,
    RejectReview,
    BlockReview,
    ResumeBuilding,
    AttestShipment,
}

/// Pure canonical lifecycle graph. Runtime handlers additionally enforce the
/// controller's identity and transition-specific guards.
pub fn allowed(transition: Transition, from: &Status, to: &Status, controller: Controller) -> bool {
    matches!(
        (transition, from, to, controller),
        (
            Transition::CloseQualified,
            Status::Open,
            Status::Qualified,
            Controller::Public
        ) | (
            Transition::CloseNotPrioritized,
            Status::Open,
            Status::NotPrioritized,
            Controller::Public
        ) | (
            Transition::MarkSpam,
            Status::Open,
            Status::Spam,
            Controller::Steward
        ) | (
            Transition::MarkDuplicate,
            Status::Open | Status::Qualified,
            Status::Duplicate,
            Controller::Steward
        ) | (
            Transition::StartBuilding,
            Status::Qualified,
            Status::Building,
            Controller::Steward
        ) | (
            Transition::Archive,
            Status::Qualified | Status::Blocked,
            Status::Archived,
            Controller::Steward
        ) | (
            Transition::RequestReview,
            Status::Building,
            Status::Review,
            Controller::Builder
        ) | (
            Transition::BlockBuilding,
            Status::Building,
            Status::Blocked,
            Controller::Builder | Controller::Steward
        ) | (
            Transition::RejectReview,
            Status::Review,
            Status::Building,
            Controller::Verifier
        ) | (
            Transition::BlockReview,
            Status::Review,
            Status::Blocked,
            Controller::Verifier
        ) | (
            Transition::ResumeBuilding,
            Status::Blocked,
            Status::Building,
            Controller::Steward
        ) | (
            Transition::AttestShipment,
            Status::Review,
            Status::Shipped,
            Controller::Verifier
        )
    )
}
