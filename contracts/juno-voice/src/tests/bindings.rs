use cosmwasm_std::{from_json, to_json_string, CustomQuery};

use crate::bindings::{JunoQuery, VotingPowerResponse};

#[test]
fn bindings_implement_custom_query() {
    fn assert_custom_query<T: CustomQuery>() {}

    assert_custom_query::<JunoQuery>();
}

#[test]
fn bindings_serialize_voting_power_at_exactly() {
    let query = JunoQuery::VotingPowerAt {
        address: "juno1voter".to_owned(),
        height: 1_234_567,
    };

    assert_eq!(
        to_json_string(&query).unwrap(),
        r#"{"voting_power_at":{"address":"juno1voter","height":1234567}}"#
    );
}

#[test]
fn bindings_serialize_total_voting_power_at_exactly() {
    let query = JunoQuery::TotalVotingPowerAt { height: 1_234_567 };

    assert_eq!(
        to_json_string(&query).unwrap(),
        r#"{"total_voting_power_at":{"height":1234567}}"#
    );
}

#[test]
fn bindings_deserialize_power_as_a_string() {
    let response: VotingPowerResponse =
        from_json(br#"{"power":"340282366920938463463374607431768211455"}"#).unwrap();

    assert_eq!(response.power, "340282366920938463463374607431768211455");
}
