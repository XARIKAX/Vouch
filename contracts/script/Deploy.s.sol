// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {CreditRegistry} from "../src/CreditRegistry.sol";
import {CreditPool} from "../src/CreditPool.sol";
import {IERC20} from "../src/interfaces/IERC20.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockUSDG} from "../src/mocks/MockUSDG.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

/// @notice Deploys Vouch Credit against the addresses in deployments/<chainId>.json
/// and writes the result back there. A chain without a record is refused: the
/// external contracts (ERC-8004 identity registry, USDG) must be resolved from the
/// record, never typed in. The local devnet (chain 31337) is the one exception:
/// without a record it gets mocks and a fresh record.
///
///   ATTESTER=0x...             the engine's attester address (defaults to the broadcaster on devnet)
///   PROTOCOL_TREASURY=0x...    receives the protocol's share of fees (defaults to the broadcaster)
///   CREDIT_LINE_CAP=1000000000 credit line cap in USDG base units (default $1,000)
///   LENDER_BPS / RESERVE_BPS / PROTOCOL_BPS   fee split, must sum to 10000 (default 7000 / 2000 / 1000)
///   MIN_LOAN / MAX_LOAN        USDG base units (default $5 / $1,000)
///   ADVANCE_BPS                share of a pending settlement that may be advanced (default 8000)
///   GRACE_SECONDS              after the due date before a default can be marked (default 3 days)
contract Deploy is Script {
    uint256 constant DEVNET = 31337;

    function run() external {
        uint256 chainId = block.chainid;
        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(chainId), ".json");

        address identity;
        address usdg;
        string memory chainName;
        string memory rpc;
        string memory explorer;

        if (vm.exists(path)) {
            string memory json = vm.readFile(path);
            identity = vm.parseJsonAddress(json, ".identityRegistry");
            usdg = vm.parseJsonAddress(json, ".usdg");
            chainName = vm.parseJsonString(json, ".name");
            rpc = vm.parseJsonString(json, ".rpc");
            explorer = vm.parseJsonString(json, ".explorer");
            if (chainId == DEVNET) {
                // a devnet restarts empty: a stale record's mocks are redeployed
                if (identity.code.length == 0) identity = address(0);
                if (usdg.code.length == 0) usdg = address(0);
            } else {
                require(identity != address(0) && usdg != address(0), "deployment record lacks identityRegistry/usdg");
            }
        } else if (chainId == DEVNET) {
            chainName = "Local devnet";
            rpc = "http://127.0.0.1:8545";
            explorer = "";
        } else {
            revert(string.concat("no deployment record for chain ", vm.toString(chainId), ": refusing to deploy"));
        }

        address attester = vm.envOr("ATTESTER", address(0));
        address treasury = vm.envOr("PROTOCOL_TREASURY", address(0));
        uint256 cap = vm.envOr("CREDIT_LINE_CAP", uint256(1000e6));
        uint16 lenderBps = uint16(vm.envOr("LENDER_BPS", uint256(7000)));
        uint16 reserveBps = uint16(vm.envOr("RESERVE_BPS", uint256(2000)));
        uint16 protocolBps = uint16(vm.envOr("PROTOCOL_BPS", uint256(1000)));
        uint128 minLoan = uint128(vm.envOr("MIN_LOAN", uint256(5e6)));
        uint128 maxLoan = uint128(vm.envOr("MAX_LOAN", uint256(1000e6)));
        uint16 advanceBps = uint16(vm.envOr("ADVANCE_BPS", uint256(8000)));
        uint64 graceSeconds = uint64(vm.envOr("GRACE_SECONDS", uint256(3 days)));

        vm.startBroadcast();
        address broadcaster = msg.sender;
        if (attester == address(0)) {
            require(chainId == DEVNET, "ATTESTER is required outside the devnet");
            attester = broadcaster;
        }
        if (treasury == address(0)) treasury = broadcaster;
        if (identity == address(0)) identity = address(new MockIdentityRegistry());
        if (usdg == address(0)) usdg = address(new MockUSDG());
        CreditRegistry registry = new CreditRegistry(IIdentityRegistry(identity), attester, cap);
        CreditPool pool = new CreditPool(IERC20(usdg), registry, attester, treasury, lenderBps, reserveBps, protocolBps, minLoan, maxLoan, advanceBps, graceSeconds);
        registry.bindPool(address(pool));
        vm.stopBroadcast();

        string memory out = "deployment";
        vm.serializeUint(out, "chainId", chainId);
        vm.serializeString(out, "name", chainName);
        vm.serializeString(out, "rpc", rpc);
        vm.serializeString(out, "explorer", explorer);
        vm.serializeAddress(out, "identityRegistry", identity);
        vm.serializeAddress(out, "usdg", usdg);
        vm.serializeAddress(out, "attester", attester);
        vm.serializeAddress(out, "creditRegistry", address(registry));
        vm.serializeAddress(out, "creditPool", address(pool));
        vm.serializeAddress(out, "protocolTreasury", treasury);
        vm.serializeUint(out, "creditLineCap", cap);
        vm.serializeUint(out, "lenderBps", lenderBps);
        vm.serializeUint(out, "reserveBps", reserveBps);
        vm.serializeUint(out, "protocolBps", protocolBps);
        vm.serializeUint(out, "minLoan", minLoan);
        vm.serializeUint(out, "maxLoan", maxLoan);
        vm.serializeUint(out, "advanceBps", advanceBps);
        vm.serializeUint(out, "graceSeconds", graceSeconds);
        string memory finalJson = vm.serializeUint(out, "deployedAt", block.timestamp);
        vm.writeJson(finalJson, path);

        console.log("chain", chainId);
        console.log("identityRegistry", identity);
        console.log("usdg", usdg);
        console.log("attester", attester);
        console.log("creditRegistry", address(registry));
        console.log("creditPool", address(pool));
        console.log("record", path);
    }
}
