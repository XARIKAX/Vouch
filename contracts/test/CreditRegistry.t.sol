// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {CreditRegistry} from "../src/CreditRegistry.sol";
import {ScoreLib} from "../src/ScoreLib.sol";
import {IIdentityRegistry} from "../src/interfaces/IIdentityRegistry.sol";
import {MockIdentityRegistry} from "../src/mocks/MockIdentityRegistry.sol";

contract CreditRegistryTest is Test {
    uint256 constant USDG = 1e6;
    MockIdentityRegistry identity;
    CreditRegistry reg;
    address attester = makeAddr("attester");
    address pool = makeAddr("pool");
    address agentOwner = makeAddr("agent");
    uint256 agentId;

    function setUp() public {
        identity = new MockIdentityRegistry();
        reg = new CreditRegistry(IIdentityRegistry(address(identity)), attester, 1000 * USDG);
        reg.bindPool(pool);
        vm.prank(agentOwner);
        agentId = identity.register("ipfs://agent");
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(CreditRegistry.ZeroAddress.selector);
        new CreditRegistry(IIdentityRegistry(address(0)), attester, 0);
        vm.expectRevert(CreditRegistry.ZeroAddress.selector);
        new CreditRegistry(IIdentityRegistry(address(identity)), address(0), 0);
    }

    function test_poolBindsOnce_byDeployerOnly() public {
        CreditRegistry fresh = new CreditRegistry(IIdentityRegistry(address(identity)), attester, 0);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(CreditRegistry.NotDeployer.selector);
        fresh.bindPool(pool);
        fresh.bindPool(pool);
        vm.expectRevert(CreditRegistry.PoolAlreadyBound.selector);
        fresh.bindPool(makeAddr("other"));
        // before a pool is bound nobody can record loan events, not even address(0)
        CreditRegistry unbound = new CreditRegistry(IIdentityRegistry(address(identity)), attester, 0);
        vm.prank(address(0));
        vm.expectRevert(CreditRegistry.NotPool.selector);
        unbound.recordDefault(agentId, "l", 1);
    }

    function test_onlyAttesterRecordsWork() public {
        vm.expectRevert(CreditRegistry.NotAttester.selector);
        reg.recordSettlement(agentId, "t1", 1);
        vm.prank(pool);
        vm.expectRevert(CreditRegistry.NotAttester.selector);
        reg.recordSlash(agentId, "t1", 1);
        vm.prank(attester);
        reg.recordSettlement(agentId, "t1", uint128(20 * USDG));
        assertEq(reg.score(agentId), 4 + 5);
    }

    function test_onlyPoolRecordsLoans() public {
        vm.prank(attester);
        vm.expectRevert(CreditRegistry.NotPool.selector);
        reg.recordRepayment(agentId, "l1", 1, 1, true);
        vm.prank(pool);
        reg.recordRepayment(agentId, "l1", uint128(100 * USDG), 10, true);
        assertEq(reg.score(agentId), 120);
    }

    function test_unknownAgentRefused() public {
        vm.prank(attester);
        vm.expectRevert(abi.encodeWithSelector(CreditRegistry.UnknownAgent.selector, 999));
        reg.recordSettlement(999, "t1", 1);
        assertFalse(reg.exists(999));
        assertTrue(reg.exists(agentId));
    }

    function test_eachReferenceRecordedOnce_perKind() public {
        vm.startPrank(attester);
        reg.recordSettlement(agentId, "t1", uint128(20 * USDG));
        vm.expectRevert();
        reg.recordSettlement(agentId, "t1", uint128(20 * USDG));
        // the same reference under a different kind is a different fact
        reg.recordSlash(agentId, "t1", uint128(1 * USDG));
        vm.stopPrank();
        vm.prank(agentOwner);
        uint256 other = identity.register("ipfs://other");
        vm.prank(attester);
        reg.recordSettlement(other, "t1", uint128(20 * USDG)); // another agent, same ref: fine
        assertEq(reg.score(other), 9);
    }

    function test_eventsAndReport() public {
        vm.prank(attester);
        vm.expectEmit(true, true, false, true);
        emit CreditRegistry.Settled(agentId, "t1", uint128(100 * USDG), uint64(block.timestamp));
        reg.recordSettlement(agentId, "t1", uint128(100 * USDG));
        vm.prank(pool);
        reg.recordDefault(agentId, "l1", uint128(50 * USDG));
        (ScoreLib.Report memory r, uint256 s, uint8 tier, uint256 fee, uint256 line, uint256 recent) = reg.creditReport(agentId);
        assertEq(r.settledCount, 1); assertEq(r.defaults, 1); assertEq(recent, 100 * USDG);
        assertEq(s, 0); assertEq(tier, 0); assertEq(fee, 0); assertEq(line, 0);
        // an established agent prices at 200 bps and gets half its recent volume as a line
        vm.startPrank(pool);
        reg.recordRecovery(agentId, "l1", uint128(50 * USDG));
        for (uint256 i = 0; i < 30; i++) reg.recordRepayment(agentId, bytes32(i), uint128(100 * USDG), 10, true);
        vm.stopPrank();
        vm.startPrank(attester);
        for (uint256 i = 0; i < 50; i++) reg.recordSettlement(agentId, bytes32(i + 1000), uint128(20 * USDG));
        vm.stopPrank();
        (, s, tier, fee, line,) = reg.creditReport(agentId);
        assertEq(s, 850 - 205); // work 450 + repay 400 - (410/2 = 205 left of the default)
        assertEq(tier, 2); assertEq(fee, 200); assertEq(line, 550 * USDG);
    }
}
