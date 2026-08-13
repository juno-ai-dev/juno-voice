import type { ConfigEnvironment } from "../config";

/** Historical v1 values in a v2-shaped automated-test fixture; never a deployable v2 identity. */
export const TEST_DEPLOYMENT_ENV: Required<ConfigEnvironment> = {
  VITE_PROTOCOL_VERSION: "v2",
  VITE_CHAIN_ID: "juno-1",
  VITE_BOUNTY_CONTRACT_ADDRESS: "juno1jmngxh7kdelch3v5xu02ze2gup887v55csqns4qmxeskgy2ldl5qj494qw",
  VITE_BOUNTY_CODE_ID: "5150",
  VITE_BOUNTY_CODE_CHECKSUM: "f05e9eaf3f90c7a5273bea3e8db8ff570b4f9192a4032472865cd4293b49bce1",
  VITE_REGISTRY_CONTRACT_ADDRESS: "juno1pg3vxw74jdwyp9w8kzsjec87lkdfyrztvqnuyp3anyevyette7cq0p377n",
  VITE_REGISTRY_CODE_ID: "5151",
  VITE_REGISTRY_CODE_CHECKSUM: "1edaf206f87958e3be62225c2cdb71345b39ca07f16b74005c463bbf7c1debbf",
  VITE_VAULT_CONTRACT_ADDRESS: "juno19uup47y5refnvl3qvq6kygcmuh2urgs40ty6kg32v9pgkpqsadasegg9jg",
  VITE_VAULT_CODE_ID: "5152",
  VITE_VAULT_CODE_CHECKSUM: "bc8b049a03496d3383376a469ccb581996238003532083895f68d4a02990a2da",
  VITE_VOTING_CONTRACT_ADDRESS: "juno1r6z5a6xggxsxgycv747e36td50pcpjf6vf9mpqrgnx4yeqnvzrtqwsjel2",
  VITE_VOTING_CODE_ID: "5153",
  VITE_VOTING_CODE_CHECKSUM: "2f336e39f9c05ad57c972eb3a51ce58ba0afaeb5944ff337d68e67644f1dad64",
  VITE_GAUGE_CONTRACT_ADDRESS: "juno1sz0m458ym24lzl3xga7j698jqq2x2mpvrjvleafzkkkxevf5x3dslwfdqn",
  VITE_GAUGE_CODE_ID: "5154",
  VITE_GAUGE_CODE_CHECKSUM: "524d5728994950bccb471ed586d2726f3594157fafccd484aa3c0c3012e8794f",
  VITE_RPC_URL: "https://rpc.example",
  VITE_EXPLORER_URL: "https://www.mintscan.io/juno",
  VITE_RELEASE_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
