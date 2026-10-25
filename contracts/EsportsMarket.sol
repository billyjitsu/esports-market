// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {AirnodeV2Attestation} from "./AirnodeV2Attestation.sol";
import {ProjectedJson} from "./ProjectedJson.sol";

/// @title Esports prediction market that settles on match results signed by the PandaScore Airnode
/// @notice Anyone opens a market on a PandaScore match, users stake ETH on one of its two teams before it starts, and
/// anyone settles it with a result that the PandaScore Airnode signed. The contract checks the signer, the request and
/// the time itself, so it does not have to trust whoever settles. The settler earns a fee, which is what pays a keeper
/// agent to buy the result and bring it on-chain.
/// @dev Each market accepts responses to one request: the `getMatch` operation for its match, projected to
/// {"status","winnerId","teamA","teamB"}. `src/pandascore.ts` builds that request and derives its hash.
contract EsportsMarket {
    using JSONParserLib for JSONParserLib.Item;

    enum Status {
        None,
        Open,
        Settled,
        Voided
    }

    struct Market {
        // Hash of the getMatch request for this market's match. The signature covers it, so a result for another
        // match recovers a different signer.
        bytes32 requestHash;
        // The PandaScore match id, for off-chain readers. Settlement relies on `requestHash`, not on this.
        uint64 matchId;
        // PandaScore team ids, in the order of the match's opponents
        uint64 teamA;
        uint64 teamB;
        // Staking stops at `closesAt`, and a result must be signed after it
        uint64 closesAt;
        // After `deadline`, anyone can void a market that nobody settled, and stakers take their stakes back
        uint64 deadline;
        uint64 winner;
        Status status;
        uint256 totalA;
        uint256 totalB;
        // What winners share, which is the pot minus the settler fee
        uint256 payout;
    }

    /// @notice Longest time from the Airnode signing a result to the contract accepting it
    uint256 public constant MAX_RESPONSE_AGE = 10 minutes;

    /// @notice Share of the pot that goes to whoever settles the market, in basis points
    uint256 public constant SETTLER_FEE_BPS = 100;

    /// @notice Address that the PandaScore Airnode signs with
    /// @dev From the x-airnode extension of the document at https://airnode-pandascore.fly.dev/. Tests deploy with a
    /// key of their own to sign results that the real Airnode never produced, such as a draw.
    address public immutable airnode;

    uint256 public marketCount;
    mapping(uint256 marketId => Market) public markets;
    mapping(uint256 marketId => mapping(address staker => uint256)) public stakesOnA;
    mapping(uint256 marketId => mapping(address staker => uint256)) public stakesOnB;
    mapping(uint256 marketId => mapping(address staker => bool)) public claimed;

    event MarketCreated(
        uint256 indexed marketId,
        uint64 indexed matchId,
        bytes32 requestHash,
        uint64 teamA,
        uint64 teamB,
        uint64 closesAt,
        uint64 deadline
    );
    event Staked(uint256 indexed marketId, address indexed staker, uint64 team, uint256 amount);
    event MarketSettled(uint256 indexed marketId, uint64 winner, address indexed settler, uint256 fee);
    event MarketVoided(uint256 indexed marketId, string reason);
    event Claimed(uint256 indexed marketId, address indexed staker, uint256 amount);

    error InvalidTeams();
    error InvalidTimes();
    error MarketNotOpen(uint256 marketId);
    error StakingClosed(uint256 marketId);
    error UnknownTeam(uint64 team);
    error NoStake();
    error ResponseTooOld(uint256 responseTimestamp);
    error SignedBeforeClose(uint256 responseTimestamp);
    error TeamsDoNotMatch(uint256 teamA, uint256 teamB);
    error MatchNotOver(string status);
    error UnknownWinner(uint256 winner);
    error DeadlineNotReached(uint256 marketId);
    error NothingToClaim(uint256 marketId);
    error TransferFailed();

    constructor(address airnode_) {
        airnode = airnode_;
    }

    /// @notice Opens a market on a match
    /// @dev Anyone can open a market, and nothing on-chain ties `requestHash` to `matchId` or the teams, so a UI or an
    /// agent should derive the hash from the match id itself and show stakers which match they bet on.
    function createMarket(
        bytes32 requestHash,
        uint64 matchId,
        uint64 teamA,
        uint64 teamB,
        uint64 closesAt,
        uint64 deadline
    ) external returns (uint256 marketId) {
        if (teamA == 0 || teamB == 0 || teamA == teamB) revert InvalidTeams();
        if (closesAt <= block.timestamp || deadline <= closesAt) revert InvalidTimes();

        marketId = ++marketCount;
        Market storage market = markets[marketId];
        market.requestHash = requestHash;
        market.matchId = matchId;
        market.teamA = teamA;
        market.teamB = teamB;
        market.closesAt = closesAt;
        market.deadline = deadline;
        market.status = Status.Open;
        emit MarketCreated(marketId, matchId, requestHash, teamA, teamB, closesAt, deadline);
    }

    /// @notice Stakes the ETH sent on `team` winning
    function stake(uint256 marketId, uint64 team) external payable {
        Market storage market = markets[marketId];
        if (market.status != Status.Open) revert MarketNotOpen(marketId);
        if (block.timestamp >= market.closesAt) revert StakingClosed(marketId);
        if (msg.value == 0) revert NoStake();

        if (team == market.teamA) {
            market.totalA += msg.value;
            stakesOnA[marketId][msg.sender] += msg.value;
        } else if (team == market.teamB) {
            market.totalB += msg.value;
            stakesOnB[marketId][msg.sender] += msg.value;
        } else {
            revert UnknownTeam(team);
        }
        emit Staked(marketId, msg.sender, team, msg.value);
    }

    /// @notice Settles a market with a result that the PandaScore Airnode signed, and pays the settler fee
    /// @dev A canceled match, a draw, or a winning side that nobody staked on voids the market instead, so everyone can
    /// take their stake back.
    /// @param timestamp `timestamp` of the response
    /// @param data `data` of the response, as the JSON string that the Airnode signed
    /// @param signature `signature` of the response
    function settle(uint256 marketId, uint256 timestamp, bytes calldata data, bytes calldata signature) external {
        Market storage market = markets[marketId];
        if (market.status != Status.Open) revert MarketNotOpen(marketId);

        // The signer and the request. The stored request hash goes into the digest, so an edited result, a result for
        // another match and a result signed with another key all recover a different signer.
        AirnodeV2Attestation.verify(airnode, market.requestHash, timestamp, data, signature);

        // The time. The signature covers the timestamp, so it is trustworthy from here on.
        if (timestamp + MAX_RESPONSE_AGE < block.timestamp) revert ResponseTooOld(timestamp);
        if (timestamp < market.closesAt) revert SignedBeforeClose(timestamp);

        // The data. The request hash fixes the projection, so the data has these four fields.
        uint256 teamA = ProjectedJson.readUint(data, "teamA", 0);
        uint256 teamB = ProjectedJson.readUint(data, "teamB", 0);
        if (teamA != market.teamA || teamB != market.teamB) revert TeamsDoNotMatch(teamA, teamB);

        string memory matchStatus = ProjectedJson.readString(data, "status");
        if (LibString.eq(matchStatus, "canceled")) {
            voidMarket(marketId, "Match canceled");
            return;
        }
        if (!LibString.eq(matchStatus, "finished")) revert MatchNotOver(matchStatus);

        // PandaScore leaves winner_id null when a finished match has no winner.
        if (JSONParserLib.parse(string(data)).at('"winnerId"').isNull()) {
            voidMarket(marketId, "No winner");
            return;
        }
        uint256 winnerId = ProjectedJson.readUint(data, "winnerId", 0);
        if (winnerId != market.teamA && winnerId != market.teamB) revert UnknownWinner(winnerId);
        // The winner is one of the two stored uint64 team ids, so the cast keeps its value.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 winner = uint64(winnerId);
        if ((winner == market.teamA ? market.totalA : market.totalB) == 0) {
            voidMarket(marketId, "Nobody staked on the winner");
            return;
        }

        uint256 pot = market.totalA + market.totalB;
        uint256 fee = pot * SETTLER_FEE_BPS / 10_000;
        market.winner = winner;
        market.payout = pot - fee;
        market.status = Status.Settled;
        emit MarketSettled(marketId, winner, msg.sender, fee);
        send(msg.sender, fee);
    }

    /// @notice Voids a market that nobody settled by its deadline, so stakers can take their stakes back
    function voidAfterDeadline(uint256 marketId) external {
        Market storage market = markets[marketId];
        if (market.status != Status.Open) revert MarketNotOpen(marketId);
        if (block.timestamp <= market.deadline) revert DeadlineNotReached(marketId);
        voidMarket(marketId, "Deadline passed");
    }

    /// @notice Pays out a winning stake's share of the pot, or refunds every stake of a voided market
    function claim(uint256 marketId) external {
        uint256 amount = claimable(marketId, msg.sender);
        if (amount == 0) revert NothingToClaim(marketId);
        claimed[marketId][msg.sender] = true;
        emit Claimed(marketId, msg.sender, amount);
        send(msg.sender, amount);
    }

    /// @notice What `staker` can claim from a market now
    function claimable(uint256 marketId, address staker) public view returns (uint256) {
        if (claimed[marketId][staker]) return 0;
        Market storage market = markets[marketId];
        if (market.status == Status.Voided) return stakesOnA[marketId][staker] + stakesOnB[marketId][staker];
        if (market.status != Status.Settled) return 0;
        if (market.winner == market.teamA) {
            return stakesOnA[marketId][staker] * market.payout / market.totalA;
        }
        return stakesOnB[marketId][staker] * market.payout / market.totalB;
    }

    function voidMarket(uint256 marketId, string memory reason) private {
        markets[marketId].status = Status.Voided;
        emit MarketVoided(marketId, reason);
    }

    function send(address recipient, uint256 amount) private {
        if (amount == 0) return;
        (bool success,) = recipient.call{value: amount}("");
        if (!success) revert TransferFailed();
    }
}
