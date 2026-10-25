// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {EsportsMarket} from "../contracts/EsportsMarket.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

contract EsportsMarketTest is AirnodeV2Test {
    struct SignedResponse {
        bytes32 requestHash;
        uint256 timestamp;
        bytes data;
        bytes signature;
    }

    address constant PANDASCORE_AIRNODE = 0xd9D29FEDc3737aD5198611457fE04aB08a739C7b;

    // Match 1200600, BST.A vs RED.A, which RED.A won:
    // {"status":"finished","winnerId":135505,"teamA":135743,"teamB":135505}
    uint64 constant MATCH_ID = 1200600;
    uint64 constant BST = 135743;
    uint64 constant RED = 135505;

    EsportsMarket market;
    SignedResponse result;
    uint256 marketId;
    uint64 closesAt;

    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address keeper = makeAddr("keeper");

    function setUp() public {
        result = readFixture("match-1200600.json");
        market = new EsportsMarket(PANDASCORE_AIRNODE);
        marketId = openMarket(market, result.requestHash, BST, RED);

        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
        vm.deal(carol, 10 ether);
        vm.prank(alice);
        market.stake{value: 3 ether}(marketId, RED);
        vm.prank(carol);
        market.stake{value: 1 ether}(marketId, RED);
        vm.prank(bob);
        market.stake{value: 4 ether}(marketId, BST);

        vm.warp(result.timestamp + 10);
    }

    function test_SettlesOnARealResultAndPaysTheSettler() public {
        vm.expectEmit(address(market));
        emit EsportsMarket.MarketSettled(marketId, RED, keeper, 0.08 ether);
        settle(result);

        // 1% of the 8 ETH pot goes to whoever settled
        assertEq(keeper.balance, 0.08 ether);
        (,,,,,, uint64 winner, EsportsMarket.Status status,,, uint256 payout) = market.markets(marketId);
        assertEq(winner, RED);
        assertEq(uint256(status), uint256(EsportsMarket.Status.Settled));
        assertEq(payout, 7.92 ether);
    }

    function test_WinnersShareThePotByStake() public {
        settle(result);

        vm.prank(alice);
        market.claim(marketId);
        vm.prank(carol);
        market.claim(marketId);
        assertEq(alice.balance, 7 ether + 5.94 ether);
        assertEq(carol.balance, 9 ether + 1.98 ether);

        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.NothingToClaim.selector, marketId));
        market.claim(marketId);
    }

    function test_RevertWhen_ClaimingTwice() public {
        settle(result);
        vm.startPrank(alice);
        market.claim(marketId);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.NothingToClaim.selector, marketId));
        market.claim(marketId);
    }

    function test_RevertWhen_SettlingTwice() public {
        settle(result);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.MarketNotOpen.selector, marketId));
        settle(result);
    }

    // The next four tests are the tamper test from the hackathon brief, with a real signed result.

    function test_RevertWhen_AValueIsEdited() public {
        SignedResponse memory editedResult = result;
        // Claims that BST.A won
        editedResult.data = '{"status":"finished","winnerId":135743,"teamA":135743,"teamB":135505}';

        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settle(editedResult);
    }

    function test_RevertWhen_TheResultIsTooOld() public {
        vm.warp(result.timestamp + market.MAX_RESPONSE_AGE() + 1);

        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.ResponseTooOld.selector, result.timestamp));
        settle(result);
    }

    function test_RevertWhen_TheResultIsForAnotherMatch() public {
        // A real result for match 1760362, MTX vs menszczysni, with the same projection
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        settle(readFixture("match-1760362.json"));
    }

    function test_RevertWhen_AnotherKeySigned() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        SignedResponse memory forgedResult = result;
        forgedResult.signature = signResponse(impostorKey, result.requestHash, result.timestamp, result.data);

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        settle(forgedResult);
    }

    function test_RevertWhen_TheMatchHasNotFinished() public {
        // A real result for match 1752540, which had not started when the Airnode signed it:
        // {"status":"not_started","winnerId":null,"teamA":139430,"teamB":138702}
        SignedResponse memory upcoming = readFixture("match-1752540.json");
        vm.warp(upcoming.timestamp - 1 hours);
        uint256 upcomingMarketId = openMarket(market, upcoming.requestHash, 139430, 138702);
        vm.warp(upcoming.timestamp + 10);

        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.MatchNotOver.selector, "not_started"));
        market.settle(upcomingMarketId, upcoming.timestamp, upcoming.data, upcoming.signature);
    }

    function test_RevertWhen_TheResultWasSignedBeforeStakingClosed() public {
        // Opens a market on the same match whose staking closes after the Airnode signed the result
        vm.warp(result.timestamp - 10 minutes);
        market.createMarket(
            result.requestHash, MATCH_ID, BST, RED, uint64(result.timestamp + 1), uint64(result.timestamp + 7 days)
        );
        uint256 lateMarketId = market.marketCount();
        vm.warp(result.timestamp + 10);

        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.SignedBeforeClose.selector, result.timestamp));
        market.settle(lateMarketId, result.timestamp, result.data, result.signature);
    }

    function test_RevertWhen_TheTeamsDoNotMatchTheMarket() public {
        // The market claims different teams than the match it hashes
        vm.warp(result.timestamp - 1 hours);
        uint256 wrongTeamsMarketId = openMarket(market, result.requestHash, 1, 2);
        vm.warp(result.timestamp + 10);

        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.TeamsDoNotMatch.selector, BST, RED));
        market.settle(wrongTeamsMarketId, result.timestamp, result.data, result.signature);
    }

    function test_RevertWhen_StakingAfterClose() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.StakingClosed.selector, marketId));
        market.stake{value: 1 ether}(marketId, RED);
    }

    function test_RevertWhen_StakingOnAnotherTeam() public {
        vm.warp(closesAt - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.UnknownTeam.selector, 42));
        market.stake{value: 1 ether}(marketId, 42);
    }

    function test_VoidsAfterTheDeadlineAndRefunds() public {
        (,,,,, uint64 deadline,,,,,) = market.markets(marketId);
        // setUp moved to the time of the saved result, which is after this market's deadline
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(EsportsMarket.DeadlineNotReached.selector, marketId));
        market.voidAfterDeadline(marketId);

        vm.warp(uint256(deadline) + 1);
        market.voidAfterDeadline(marketId);
        vm.prank(bob);
        market.claim(marketId);
        assertEq(bob.balance, 10 ether);
    }

    // Results that the real Airnode has not produced for a saved match, signed with a test key instead

    function test_VoidsOnADraw() public {
        (EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey) = openTestMarket();
        settleWithTestKey(
            testMarket, testMarketId, airnodeKey, '{"status":"finished","winnerId":null,"teamA":1,"teamB":2}'
        );

        assertMarketVoidedAndRefunds(testMarket, testMarketId);
    }

    function test_VoidsOnACanceledMatch() public {
        (EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey) = openTestMarket();
        settleWithTestKey(
            testMarket, testMarketId, airnodeKey, '{"status":"canceled","winnerId":null,"teamA":1,"teamB":2}'
        );

        assertMarketVoidedAndRefunds(testMarket, testMarketId);
    }

    function test_VoidsWhenNobodyStakedOnTheWinner() public {
        (EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey) = openTestMarket();
        // Alice staked only on team 1
        settleWithTestKey(
            testMarket, testMarketId, airnodeKey, '{"status":"finished","winnerId":2,"teamA":1,"teamB":2}'
        );

        assertMarketVoidedAndRefunds(testMarket, testMarketId);
    }

    function test_AcceptsTheFieldsInAnyOrder() public {
        (EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey) = openTestMarket();
        settleWithTestKey(
            testMarket, testMarketId, airnodeKey, '{"teamB":2,"teamA":1,"winnerId":1,"status":"finished"}'
        );

        (,,,,,, uint64 winner, EsportsMarket.Status status,,,) = testMarket.markets(testMarketId);
        assertEq(winner, 1);
        assertEq(uint256(status), uint256(EsportsMarket.Status.Settled));
    }

    function openMarket(EsportsMarket target, bytes32 requestHash, uint64 teamA, uint64 teamB)
        private
        returns (uint256)
    {
        closesAt = uint64(block.timestamp + 30 minutes);
        return target.createMarket(requestHash, MATCH_ID, teamA, teamB, closesAt, closesAt + 7 days);
    }

    function openTestMarket() private returns (EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey) {
        address testAirnode;
        (testAirnode, airnodeKey) = makeAddrAndKey("test airnode");
        testMarket = new EsportsMarket(testAirnode);
        testMarketId = openMarket(testMarket, keccak256("test request"), 1, 2);
        vm.prank(alice);
        testMarket.stake{value: 1 ether}(testMarketId, 1);
        vm.warp(closesAt + 1);
    }

    function settleWithTestKey(EsportsMarket testMarket, uint256 testMarketId, uint256 airnodeKey, bytes memory data)
        private
    {
        bytes memory signature = signResponse(airnodeKey, keccak256("test request"), block.timestamp, data);
        vm.prank(keeper);
        testMarket.settle(testMarketId, block.timestamp, data, signature);
    }

    function assertMarketVoidedAndRefunds(EsportsMarket testMarket, uint256 testMarketId) private {
        (,,,,,,, EsportsMarket.Status status,,,) = testMarket.markets(testMarketId);
        assertEq(uint256(status), uint256(EsportsMarket.Status.Voided));
        assertEq(keeper.balance, 0);
        uint256 balanceBefore = alice.balance;
        vm.prank(alice);
        testMarket.claim(testMarketId);
        assertEq(alice.balance, balanceBefore + 1 ether);
    }

    // Reads a result that `pnpm --silent fetch-result <match id>` saved.
    function readFixture(string memory name) private view returns (SignedResponse memory) {
        string memory json = vm.readFile(string.concat("test/fixtures/", name));
        return SignedResponse({
            requestHash: vm.parseJsonBytes32(json, ".requestHash"),
            timestamp: vm.parseJsonUint(json, ".timestamp"),
            data: bytes(vm.parseJsonString(json, ".data")),
            signature: vm.parseJsonBytes(json, ".signature")
        });
    }

    function settle(SignedResponse memory response) private {
        vm.prank(keeper);
        market.settle(marketId, response.timestamp, response.data, response.signature);
    }
}
