use cosmwasm_schema::cw_serde;
use cosmwasm_std::CustomQuery;

#[cw_serde]
pub enum JunoQuery {
    VotingPowerAt { address: String, height: i64 },
    TotalVotingPowerAt { height: i64 },
}

impl CustomQuery for JunoQuery {}

#[cw_serde]
pub struct VotingPowerResponse {
    pub power: String,
}
