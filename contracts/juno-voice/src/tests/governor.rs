use cosmwasm_std::testing::{message_info, mock_env, MockApi, MockQuerier, MockStorage};
use cosmwasm_std::{coin, to_json_string, Addr, OwnedDeps, Uint128};

use crate::bindings::JunoQuery;
use crate::contract::{execute, instantiate};
use crate::error::ContractError;
use crate::msg::{ExecuteMsg, InstantiateMsg};
use crate::state::{
    ProtocolAction, RequestLimits, CONFIG, NEXT_PROTOCOL_ACTION_ID, PROTOCOL_ACTIONS,
};

fn deps() -> OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery> {
    OwnedDeps {
        storage: MockStorage::default(),
        api: MockApi::default(),
        querier: MockQuerier::new(&[]),
        custom_query_type: std::marker::PhantomData,
    }
}

fn setup() -> (
    OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>,
    Addr,
    Addr,
    Addr,
) {
    let mut deps = deps();
    let api = MockApi::default();
    let governor = api.addr_make("governor");
    let first = api.addr_make("first");
    let second = api.addr_make("second");
    instantiate(
        deps.as_mut(),
        mock_env(),
        message_info(&api.addr_make("creator"), &[]),
        InstantiateMsg {
            governor: governor.to_string(),
            steward: api.addr_make("steward").to_string(),
            verifier: api.addr_make("verifier").to_string(),
            native_denom: "ujuno".into(),
            submission_bond: Uint128::new(1),
            voting_period_blocks: 10,
            quorum_bps: 1,
            support_bps: 5_001,
            work_inactivity_blocks: 20,
            request_limits: RequestLimits::default(),
            max_reason_bytes: 12,
            default_query_limit: 1,
            max_query_limit: 10,
            evidence_policy_version: 1,
        },
    )
    .unwrap();
    (deps, governor, first, second)
}

fn run(
    deps: &mut OwnedDeps<MockStorage, MockApi, MockQuerier<JunoQuery>, JunoQuery>,
    sender: &Addr,
    msg: ExecuteMsg,
) -> Result<cosmwasm_std::Response, ContractError> {
    execute(deps.as_mut(), mock_env(), message_info(sender, &[]), msg)
}

#[test]
fn propose_governor_uses_the_canonical_address_wire_field() {
    let json = to_json_string(&ExecuteMsg::ProposeGovernor {
        address: "juno1nominee".into(),
        reason: "succession".into(),
    })
    .unwrap();
    assert_eq!(
        json,
        r#"{"propose_governor":{"address":"juno1nominee","reason":"succession"}}"#
    );
}

#[test]
fn governor_can_propose_replace_cancel_and_nominee_can_accept_with_typed_audit() {
    let (mut deps, governor, first, second) = setup();
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ProposeGovernor {
            address: first.to_string(),
            reason: "  initial  ".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ProposeGovernor {
            address: second.to_string(),
            reason: "replacement".into(),
        },
    )
    .unwrap();

    assert_eq!(
        CONFIG.load(&deps.storage).unwrap().pending_governor,
        Some(second.clone())
    );
    assert_eq!(
        PROTOCOL_ACTIONS
            .load(&deps.storage, 1)
            .unwrap()
            .reason
            .as_deref(),
        Some("initial")
    );
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 1).unwrap().action,
        ProtocolAction::GovernorProposed {
            previous_nominee: None,
            nominee: first.clone()
        }
    );
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 2).unwrap().action,
        ProtocolAction::GovernorProposed {
            previous_nominee: Some(first),
            nominee: second.clone()
        }
    );

    run(
        &mut deps,
        &governor,
        ExecuteMsg::CancelGovernorTransfer {
            reason: "cancel".into(),
        },
    )
    .unwrap();
    assert_eq!(CONFIG.load(&deps.storage).unwrap().pending_governor, None);
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 3).unwrap().action,
        ProtocolAction::GovernorTransferCancelled {
            nominee: second.clone()
        }
    );

    run(
        &mut deps,
        &governor,
        ExecuteMsg::ProposeGovernor {
            address: second.to_string(),
            reason: "again".into(),
        },
    )
    .unwrap();
    run(
        &mut deps,
        &second,
        ExecuteMsg::AcceptGovernor {
            reason: "accept".into(),
        },
    )
    .unwrap();
    let config = CONFIG.load(&deps.storage).unwrap();
    assert_eq!(config.governor, second.clone());
    assert_eq!(config.pending_governor, None);
    assert_eq!(
        PROTOCOL_ACTIONS.load(&deps.storage, 5).unwrap().action,
        ProtocolAction::GovernorAccepted {
            previous: governor,
            governor: second
        }
    );
    assert_eq!(NEXT_PROTOCOL_ACTION_ID.load(&deps.storage).unwrap(), 6);
}

#[test]
fn governor_workflow_rejects_funds_authority_invalid_transitions_and_reasons() {
    let (mut deps, governor, first, second) = setup();
    let env = mock_env();
    let funded = execute(
        deps.as_mut(),
        env,
        message_info(&governor, &[coin(1, "ujuno")]),
        ExecuteMsg::ProposeGovernor {
            address: first.to_string(),
            reason: "ok".into(),
        },
    )
    .unwrap_err();
    assert_eq!(funded, ContractError::UnexpectedFunds);

    assert_eq!(
        run(
            &mut deps,
            &first,
            ExecuteMsg::ProposeGovernor {
                address: second.to_string(),
                reason: "ok".into(),
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::ProposeGovernor {
                address: governor.to_string(),
                reason: "ok".into(),
            }
        )
        .unwrap_err(),
        ContractError::InvalidGovernorNominee
    );
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::ProposeGovernor {
                address: String::new(),
                reason: "ok".into(),
            }
        )
        .unwrap_err(),
        ContractError::InvalidAddress {
            role: "governor nominee"
        }
    );
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::CancelGovernorTransfer {
                reason: "ok".into(),
            }
        )
        .unwrap_err(),
        ContractError::NoPendingGovernor
    );
    assert_eq!(
        run(
            &mut deps,
            &first,
            ExecuteMsg::AcceptGovernor {
                reason: "ok".into(),
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );

    for reason in ["   ", "1234567890123", "🦀🦀🦀🦀", "       ok       "] {
        assert_eq!(
            run(
                &mut deps,
                &governor,
                ExecuteMsg::ProposeGovernor {
                    address: first.to_string(),
                    reason: reason.into(),
                }
            )
            .unwrap_err(),
            ContractError::InvalidReason
        );
    }
    run(
        &mut deps,
        &governor,
        ExecuteMsg::ProposeGovernor {
            address: first.to_string(),
            reason: "valid".into(),
        },
    )
    .unwrap();
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::CancelGovernorTransfer {
                reason: "  ".into(),
            }
        )
        .unwrap_err(),
        ContractError::InvalidReason
    );
    assert_eq!(
        run(
            &mut deps,
            &first,
            ExecuteMsg::AcceptGovernor {
                reason: "🦀🦀🦀🦀".into(),
            }
        )
        .unwrap_err(),
        ContractError::InvalidReason
    );
    assert_eq!(
        CONFIG.load(&deps.storage).unwrap().pending_governor,
        Some(first.clone())
    );
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::ProposeGovernor {
                address: first.to_string(),
                reason: "valid".into(),
            }
        )
        .unwrap_err(),
        ContractError::InvalidGovernorNominee
    );
    assert_eq!(
        run(
            &mut deps,
            &second,
            ExecuteMsg::AcceptGovernor {
                reason: "valid".into(),
            }
        )
        .unwrap_err(),
        ContractError::Unauthorized
    );
}

#[test]
fn protocol_action_id_overflow_is_checked_before_mutation() {
    let (mut deps, governor, first, _) = setup();
    NEXT_PROTOCOL_ACTION_ID
        .save(&mut deps.storage, &u64::MAX)
        .unwrap();
    assert_eq!(
        run(
            &mut deps,
            &governor,
            ExecuteMsg::ProposeGovernor {
                address: first.to_string(),
                reason: "valid".into(),
            }
        )
        .unwrap_err(),
        ContractError::ProtocolActionIdOverflow
    );
    assert_eq!(CONFIG.load(&deps.storage).unwrap().pending_governor, None);
    assert!(!PROTOCOL_ACTIONS.has(&deps.storage, u64::MAX));
}
