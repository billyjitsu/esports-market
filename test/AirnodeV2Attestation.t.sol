// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {AirnodeV2Attestation} from "../contracts/AirnodeV2Attestation.sol";
import {AirnodeV2Test} from "./utils/AirnodeV2Test.sol";

// The library functions are internal, so the tests call them through a contract, where expectRevert can catch a revert.
contract AirnodeV2AttestationHarness {
    function recoverSigner(bytes32 requestHash, uint256 timestamp, bytes calldata data, bytes calldata signature)
        external
        pure
        returns (address)
    {
        return AirnodeV2Attestation.recoverSigner(requestHash, timestamp, data, signature);
    }

    function verify(
        address airnode,
        bytes32 requestHash,
        uint256 timestamp,
        bytes calldata data,
        bytes calldata signature
    ) external pure {
        AirnodeV2Attestation.verify(airnode, requestHash, timestamp, data, signature);
    }
}

contract AirnodeV2AttestationTest is AirnodeV2Test {
    // A response that the Nodary Airnode v2 signed on 2026-10-19, for the latestFeeds operation with the name ETH/USD
    // and the projection {"price":"/ETH~1USD/value","updatedAt":"/ETH~1USD/timestamp"}.
    address constant NODARY_AIRNODE_V2 = 0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0;
    bytes32 constant REQUEST_HASH = 0x180eae9387bb66a72380e61ebe0a00d19f8414a716a37ebe1df124b66acfff66;
    uint256 constant TIMESTAMP = 1792403240;
    bytes constant DATA = '{"price":2443.95,"updatedAt":1792403240691}';
    bytes constant SIGNATURE =
        hex"b034c17a11679ff06e50445c84419c34ba0aee5669bbda3a0dd563d2437928a17e5b34826fd505b0d1cace3712570df07de0d0a7eb2e1610c84cd4a0d71827e21b";

    AirnodeV2AttestationHarness harness = new AirnodeV2AttestationHarness();

    function test_RecoverSigner_ReturnsTheAirnodeOfARealResponse() public view {
        assertEq(harness.recoverSigner(REQUEST_HASH, TIMESTAMP, DATA, SIGNATURE), NODARY_AIRNODE_V2);
    }

    function test_Verify_AcceptsARealResponse() public view {
        harness.verify(NODARY_AIRNODE_V2, REQUEST_HASH, TIMESTAMP, DATA, SIGNATURE);
    }

    function test_RevertWhen_DataIsEdited() public {
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        harness.verify(
            NODARY_AIRNODE_V2, REQUEST_HASH, TIMESTAMP, '{"price":1443.95,"updatedAt":1792403240691}', SIGNATURE
        );
    }

    function test_RevertWhen_TimestampIsEdited() public {
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        harness.verify(NODARY_AIRNODE_V2, REQUEST_HASH, TIMESTAMP + 1, DATA, SIGNATURE);
    }

    function test_RevertWhen_RequestHashDiffers() public {
        vm.expectPartialRevert(AirnodeV2Attestation.NotSignedByAirnode.selector);
        harness.verify(NODARY_AIRNODE_V2, keccak256("another request"), TIMESTAMP, DATA, SIGNATURE);
    }

    function test_RevertWhen_AnotherKeySigned() public {
        (address impostor, uint256 impostorKey) = makeAddrAndKey("impostor");
        bytes memory signature = signResponse(impostorKey, REQUEST_HASH, TIMESTAMP, DATA);

        vm.expectRevert(abi.encodeWithSelector(AirnodeV2Attestation.NotSignedByAirnode.selector, impostor));
        harness.verify(NODARY_AIRNODE_V2, REQUEST_HASH, TIMESTAMP, DATA, signature);
    }

    function test_RevertWhen_SignatureIsNot65Bytes() public {
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        harness.verify(NODARY_AIRNODE_V2, REQUEST_HASH, TIMESTAMP, DATA, new bytes(64));
    }

    function testFuzz_Verify_AcceptsAnyResponseTheAirnodeSigned(
        bytes32 requestHash,
        uint256 timestamp,
        bytes memory data
    ) public {
        (address airnode, uint256 airnodeKey) = makeAddrAndKey("airnode");
        harness.verify(airnode, requestHash, timestamp, data, signResponse(airnodeKey, requestHash, timestamp, data));
    }
}
