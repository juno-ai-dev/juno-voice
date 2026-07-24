use cosmwasm_std::Uint128;

pub(crate) const RANK_KEY_LEN: usize = 42;
const RANK_KEY_VERSION: u8 = 1;

/// Frozen canonical rank key: signed net descending, support descending, then
/// oldest request id first when the bytes are iterated in descending order.
pub(crate) fn rank_key(support: Uint128, oppose: Uint128, request_id: u64) -> Vec<u8> {
    let (sign_bucket, sortable_net) = if support >= oppose {
        (
            1,
            support
                .checked_sub(oppose)
                .expect("comparison proves nonnegative net"),
        )
    } else {
        let magnitude = oppose
            .checked_sub(support)
            .expect("comparison proves negative-net magnitude");
        (
            0,
            Uint128::MAX
                .checked_sub(magnitude)
                .expect("magnitude cannot exceed Uint128::MAX"),
        )
    };

    let mut key = Vec::with_capacity(RANK_KEY_LEN);
    key.push(RANK_KEY_VERSION);
    key.push(sign_bucket);
    key.extend_from_slice(&sortable_net.u128().to_be_bytes());
    key.extend_from_slice(&support.u128().to_be_bytes());
    key.extend_from_slice(&(u64::MAX - request_id).to_be_bytes());
    key
}
