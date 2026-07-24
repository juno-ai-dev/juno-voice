use cosmwasm_std::testing::MockStorage;
use cosmwasm_std::{from_json, to_json_binary, Addr, Timestamp, Uint128};

use crate::state::{
    FutureRequestPolicy, ProtocolAction, ProtocolActionRecord, RequestAction, RequestLimits,
    PROTOCOL_ACTIONS,
};

#[test]
fn audit_variants_serialize_complete_typed_prior_and_new_facts() {
    let old_policy = FutureRequestPolicy {
        submission_bond: Uint128::new(10),
        voting_period_blocks: 20,
        quorum_bps: 30,
        support_bps: 40,
        work_inactivity_blocks: 50,
        request_limits: RequestLimits::default(),
    };
    let mut new_policy = old_policy.clone();
    new_policy.submission_bond = Uint128::new(11);
    let action = ProtocolActionRecord {
        id: 7,
        actor: Addr::unchecked("actor"),
        action: ProtocolAction::ConfigUpdated {
            old_policy: old_policy.clone(),
            new_policy: new_policy.clone(),
        },
        reason: Some("policy".into()),
        height: 8,
        timestamp: Timestamp::from_seconds(9),
    };
    let mut storage = MockStorage::default();
    PROTOCOL_ACTIONS.save(&mut storage, 7, &action).unwrap();
    let mut later_action = action.clone();
    later_action.id = 8;
    later_action.action = ProtocolAction::GovernorTransferCancelled {
        nominee: Addr::unchecked("later"),
    };
    PROTOCOL_ACTIONS
        .save(&mut storage, 8, &later_action)
        .unwrap();
    assert_eq!(PROTOCOL_ACTIONS.load(&storage, 7).unwrap(), action);

    let stored: ProtocolActionRecord = from_json(to_json_binary(&action).unwrap()).unwrap();
    assert_eq!(stored, action);
    assert_eq!(
        stored.action,
        ProtocolAction::ConfigUpdated {
            old_policy,
            new_policy
        }
    );

    let previous = Addr::unchecked("previous");
    let new = Addr::unchecked("new");
    let assignment = RequestAction::BuilderAssigned {
        previous_builder: Some(previous.clone()),
        new_builder: new.clone(),
        previous_work_round: 4,
        new_work_round: 5,
    };
    let stored_assignment: RequestAction = from_json(to_json_binary(&assignment).unwrap()).unwrap();
    assert_eq!(stored_assignment, assignment);

    // Later values are distinct objects and cannot rewrite serialized audit facts.
    let mut current_builder = Some(new);
    let mut current_round = 5;
    assert_eq!(current_builder, Some(Addr::unchecked("new")));
    current_builder = None;
    current_round += 1;
    assert_eq!(
        stored_assignment,
        RequestAction::BuilderAssigned {
            previous_builder: Some(previous),
            new_builder: Addr::unchecked("new"),
            previous_work_round: 4,
            new_work_round: 5,
        }
    );
    assert_eq!((current_builder, current_round), (None, 6));
}
