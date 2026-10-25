// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Test} from "forge-std/Test.sol";
import {JSONParserLib} from "solady/utils/JSONParserLib.sol";
import {IsoTimestamp} from "../contracts/IsoTimestamp.sol";
import {ProjectedJson} from "../contracts/ProjectedJson.sol";

// The library functions are internal, so the tests call them through a contract, where expectRevert can catch a revert.
contract ProjectedJsonHarness {
    function readUint(bytes calldata json, string calldata key, uint8 decimals) external pure returns (uint256) {
        return ProjectedJson.readUint(json, key, decimals);
    }

    function readInt(bytes calldata json, string calldata key, uint8 decimals) external pure returns (int256) {
        return ProjectedJson.readInt(json, key, decimals);
    }

    function readBool(bytes calldata json, string calldata key) external pure returns (bool) {
        return ProjectedJson.readBool(json, key);
    }

    function readString(bytes calldata json, string calldata key) external pure returns (string memory) {
        return ProjectedJson.readString(json, key);
    }

    function isNull(bytes calldata json, string calldata key) external pure returns (bool) {
        return ProjectedJson.isNull(json, key);
    }

    function readTimestamp(bytes calldata json, string calldata key) external pure returns (uint256) {
        return ProjectedJson.readTimestamp(json, key);
    }

    function readAddress(bytes calldata json, string calldata key) external pure returns (address) {
        return ProjectedJson.readAddress(json, key);
    }

    function readBytes32(bytes calldata json, string calldata key) external pure returns (bytes32) {
        return ProjectedJson.readBytes32(json, key);
    }

    function readHexUint(bytes calldata json, string calldata key) external pure returns (uint256) {
        return ProjectedJson.readHexUint(json, key);
    }

    function readUintAt(bytes calldata json, uint256 index, uint8 decimals) external pure returns (uint256) {
        return ProjectedJson.readUint(json, index, decimals);
    }

    function readStringAt(bytes calldata json, uint256 index) external pure returns (string memory) {
        return ProjectedJson.readString(json, index);
    }
}

contract ProjectedJsonTest is Test {
    ProjectedJsonHarness harness = new ProjectedJsonHarness();

    function test_ReadUint_ReadsAnInteger() public view {
        assertEq(harness.readUint('{"updatedAt":1792403240691}', "updatedAt", 0), 1792403240691);
    }

    function test_ReadUint_ScalesADecimalToTheRequestedDecimals() public view {
        assertEq(harness.readUint('{"price":2443.95}', "price", 18), 2443.95e18);
        assertEq(harness.readUint('{"price":2443.95}', "price", 2), 244395);
    }

    function test_ReadUint_CutsOffDigitsAfterTheRequestedDecimals() public view {
        assertEq(harness.readUint('{"price":2443.959}', "price", 2), 244395);
        assertEq(harness.readUint('{"price":0.004}', "price", 2), 0);
    }

    function test_ReadUint_ReadsVerySmallAndVeryLargeNumbers() public view {
        assertEq(harness.readUint('{"price":0.00000012}', "price", 18), 1.2e11);
        assertEq(harness.readUint('{"supply":2500000000000000000000}', "supply", 0), 2.5e21);
    }

    function test_ReadUint_ReadsZero() public view {
        assertEq(harness.readUint('{"value":0}', "value", 18), 0);
    }

    function test_ReadUint_ReadsNegativeZero() public view {
        assertEq(harness.readUint('{"value":-0}', "value", 18), 0);
        assertEq(harness.readUint('{"value":-0.0}', "value", 18), 0);
        assertEq(harness.readUint('{"value":"-0"}', "value", 18), 0);
    }

    function test_ReadInt_ReadsNegativeNumbers() public view {
        assertEq(harness.readInt('{"temperature":-12.5}', "temperature", 1), -125);
        assertEq(harness.readInt('{"temperature":-1.239}', "temperature", 2), -123);
        assertEq(harness.readInt('{"rate":-0.00000015}', "rate", 9), -150);
        assertEq(harness.readInt('{"temperature":21}', "temperature", 0), 21);
    }

    function test_ReadBool_ReadsTrueAndFalse() public view {
        assertTrue(harness.readBool('{"isFinal":true}', "isFinal"));
        assertFalse(harness.readBool('{"isFinal":false}', "isFinal"));
    }

    function test_ReadString_ReadsTheTextBetweenTheQuotes() public view {
        assertEq(harness.readString('{"category":"crypto"}', "category"), "crypto");
        assertEq(harness.readString('{"category":""}', "category"), "");
    }

    function test_ReadString_DecodesEscapeSequences() public view {
        assertEq(harness.readString('{"note":"say \\"hi\\""}', "note"), 'say "hi"');
        assertEq(harness.readString('{"city":"Z\\u00fcrich"}', "city"), unicode"Zürich");
    }

    function test_ReadUint_ReadsANumberInAString() public view {
        assertEq(harness.readUint('{"mid":"0.0005"}', "mid", 18), 0.0005e18);
        assertEq(harness.readUint('{"mid":"0.12345"}', "mid", 2), 12);
        assertEq(harness.readUint('{"totalAssets":"2500000000000000000000"}', "totalAssets", 0), 2.5e21);
    }

    function test_ReadInt_ReadsANegativeNumberInAString() public view {
        assertEq(harness.readInt('{"funding":"-0.0000125"}', "funding", 9), -12500);
        assertEq(harness.readInt('{"funding":"0.0000125"}', "funding", 9), 12500);
    }

    function test_RevertWhen_AStringDoesNotHoldANumber() public {
        string[8] memory values = ['""', '"abc"', '"1."', '".5"', '"+1"', '"1.2.3"', '"1e-7"', '"0x1"'];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(JSONParserLib.ParsingFailed.selector);
            harness.readUint(bytes.concat('{"mid":', bytes(values[index]), "}"), "mid", 18);
        }
    }

    function test_RevertWhen_AStringHoldsAnotherJsonValue() public {
        string[3] memory values = ['"true"', '"null"', '"[1]"'];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "mid"));
            harness.readUint(bytes.concat('{"mid":', bytes(values[index]), "}"), "mid", 18);
        }
    }

    function test_RevertWhen_ReadUintFindsANegativeNumberInAString() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "mid"));
        harness.readUint('{"mid":"-1"}', "mid", 0);
    }

    function test_IsNull_TellsNullFromOtherValues() public view {
        assertTrue(harness.isNull('{"winnerId":null}', "winnerId"));
        string[5] memory values = ["0", "false", '""', '"null"', "[]"];
        for (uint256 index = 0; index < values.length; index++) {
            assertFalse(harness.isNull(bytes.concat('{"winnerId":', bytes(values[index]), "}"), "winnerId"));
        }
    }

    function test_RevertWhen_IsNullFindsNoField() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "winnerId"));
        harness.isNull('{"status":"running"}', "winnerId");
    }

    function test_ReadTimestamp_ReadsAFieldWithIsoTimestamp() public view {
        assertEq(harness.readTimestamp('{"endDate":"2024-11-05T12:00:00Z"}', "endDate"), 1730808000);
    }

    function test_RevertWhen_ATimestampIsMalformed() public {
        vm.expectRevert(abi.encodeWithSelector(IsoTimestamp.InvalidTimestamp.selector, "2024-11-05T12:00:00"));
        harness.readTimestamp('{"endDate":"2024-11-05T12:00:00"}', "endDate");
    }

    function test_RevertWhen_ATimestampIsNotAString() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "time"));
        harness.readTimestamp('{"time":1730808000}', "time");
    }

    function test_ReadAddress_ReadsAHexString() public view {
        assertEq(
            harness.readAddress('{"vault":"0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0"}', "vault"),
            0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0
        );
        assertEq(
            harness.readAddress('{"vault":"0xe70f1e8b22a21e4bb5188918a3033341b281e4c0"}', "vault"),
            0xE70f1e8b22a21e4Bb5188918a3033341b281E4c0
        );
    }

    function test_ReadBytes32_ReadsAHexString() public view {
        // A Polymarket condition id
        assertEq(
            harness.readBytes32(
                '{"conditionId":"0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917"}', "conditionId"
            ),
            0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917
        );
    }

    function test_RevertWhen_AStringIsNotAnAddress() public {
        // A Solana address, too few and too many digits, and a character that is not hex
        string[4] memory values = [
            "So11111111111111111111111111111111111111112",
            "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c",
            "0xE70f1e8b22a21e4Bb5188918a3033341b281E4c00",
            "0xG70f1e8b22a21e4Bb5188918a3033341b281E4c0"
        ];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(Strings.StringsInvalidAddressFormat.selector);
            harness.readAddress(bytes.concat('{"token":"', bytes(values[index]), '"}'), "token");
        }
    }

    function test_ReadBytes32_ReadsHexWithoutThePrefix() public view {
        assertEq(
            harness.readBytes32(
                '{"conditionId":"dd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917"}', "conditionId"
            ),
            0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917
        );
    }

    function test_RevertWhen_Bytes32HasAnotherLength() public {
        // 63 and 65 digits, and a short id that could have lost zeros at either end
        string[3] memory values = [
            "0xd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917",
            "0xdd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead1109170",
            "0x1234"
        ];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "conditionId"));
            harness.readBytes32(bytes.concat('{"conditionId":"', bytes(values[index]), '"}'), "conditionId");
        }
    }

    function test_ReadHexUint_ReadsAHexNumberOfAnyLength() public view {
        // An eth_getBalance answer of 2 ETH, which drops leading zeros as JSON-RPC does
        assertEq(harness.readHexUint('{"balance":"0x1bc16d674ec80000"}', "balance"), 2 ether);
        assertEq(harness.readHexUint('{"balance":"0x0"}', "balance"), 0);
        assertEq(harness.readHexUint('{"balance":"ff"}', "balance"), 255);
    }

    function test_ReadHexUint_PutsDroppedZerosBackInFrontOfAnId() public view {
        assertEq(bytes32(harness.readHexUint('{"id":"0xab"}', "id")), bytes32(uint256(0xab)));
    }

    function test_RevertWhen_AHexNumberHasNoDigits() public {
        string[2] memory values = ["", "0x"];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "balance"));
            harness.readHexUint(bytes.concat('{"balance":"', bytes(values[index]), '"}'), "balance");
        }
    }

    function test_RevertWhen_AStringIsNotHex() public {
        vm.expectRevert(Strings.StringsInvalidChar.selector);
        harness.readBytes32(
            '{"conditionId":"0xGd22472e552920b8438158ea7238bfadfa4f736aa4cee91a6b86c39ead110917"}', "conditionId"
        );
    }

    function test_ReadsAnItemOfAnArrayInAString() public view {
        // Polymarket's resolved market "Will Donald Trump win the 2024 US Presidential Election?"
        bytes memory market =
            '{"clobTokenIds":"[\\"21742633143463906290569050155826241533067272736897614950488156847949938836455\\", \\"48331043336612883890938759509493159234755048973500640148014422747788308965732\\"]","outcomePrices":"[\\"1\\", \\"0\\"]","outcomes":"[\\"Yes\\", \\"No\\"]"}';
        bytes memory outcomePrices = bytes(harness.readString(market, "outcomePrices"));
        assertEq(harness.readUintAt(outcomePrices, 0, 18), 1e18);
        assertEq(harness.readUintAt(outcomePrices, 1, 18), 0);
        assertEq(harness.readStringAt(bytes(harness.readString(market, "outcomes")), 0), "Yes");
        assertEq(
            harness.readUintAt(bytes(harness.readString(market, "clobTokenIds")), 0, 0),
            21742633143463906290569050155826241533067272736897614950488156847949938836455
        );
    }

    function test_ReadsAnItemOfAnArray() public view {
        assertEq(harness.readUintAt("[1, 2.5]", 1, 18), 2.5e18);
        assertEq(harness.readStringAt('["Yes", "No"]', 1), "No");
    }

    function test_RevertWhen_AnArrayHasNoItemAtTheIndex() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "2"));
        harness.readUintAt("[1, 0]", 2, 18);
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "0"));
        harness.readUintAt('{"0":1}', 0, 18);
    }

    function test_RevertWhen_AnItemIsNotWhatIsExpected() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "0"));
        harness.readStringAt("[1]", 0);
    }

    function test_ReadsJsonWithWhitespace() public view {
        assertEq(harness.readUint('{ "price" : 2443.95,\n  "updatedAt" : 1792403240691 }', "price", 2), 244395);
    }

    function test_FindsAFieldInAnyPosition() public view {
        bytes memory json = '{"price":2443.95,"updatedAt":1792403240691,"category":"crypto"}';
        assertEq(harness.readUint(json, "price", 2), 244395);
        assertEq(harness.readUint(json, "updatedAt", 0), 1792403240691);
        assertEq(harness.readString(json, "category"), "crypto");
    }

    function test_MatchesOnlyTheWholeFieldName() public view {
        assertEq(harness.readUint('{"prices":1,"price":2}', "price", 0), 2);
    }

    function test_IgnoresFieldNamesInsideStrings() public view {
        assertEq(harness.readUint('{"note":"\\",\\"price\\":1","price":2}', "price", 0), 2);
    }

    function test_SkipsNestedObjectsAndArrays() public view {
        bytes memory json = '{"feed":{"price":1,"sources":["a}",[2]]},"price":2}';
        assertEq(harness.readUint(json, "price", 0), 2);
    }

    function test_RevertWhen_FieldIsMissing() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "price"));
        harness.readUint('{"updatedAt":1792403240691}', "price", 0);
    }

    function test_RevertWhen_FieldIsNested() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "price"));
        harness.readUint('{"feed":{"price":1}}', "price", 0);
    }

    function test_RevertWhen_ReadUintFindsANegativeNumber() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "temperature"));
        harness.readUint('{"temperature":-1}', "temperature", 0);
        // Negative, although 2 decimals cut it to zero
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "temperature"));
        harness.readUint('{"temperature":-0.001}', "temperature", 2);
    }

    function test_RevertWhen_ANumberIsExpectedButTheValueIsNot() public {
        string[4] memory values = ["true", "null", '{"value":1}', "[1]"];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "price"));
            harness.readUint(bytes.concat('{"price":', bytes(values[index]), "}"), "price", 0);
        }
    }

    function test_RevertWhen_ANumberUsesExponentNotation() public {
        // JSONParserLib accepts these as JSON numbers, but its parseUint reads only digits.
        string[3] memory values = ["1.2e-7", "1e+21", "2.5E+21"];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(JSONParserLib.ParsingFailed.selector);
            harness.readUint(bytes.concat('{"price":', bytes(values[index]), "}"), "price", 0);
        }
    }

    function test_RevertWhen_TheJsonIsInvalid() public {
        string[6] memory jsons = ['{"price":-}', '{"price":1.}', '{"price":.5}', '{"price":}', '{"note":"abc}', ""];
        for (uint256 index = 0; index < jsons.length; index++) {
            vm.expectRevert(JSONParserLib.ParsingFailed.selector);
            harness.readUint(bytes(jsons[index]), "price", 0);
        }
    }

    function test_RevertWhen_ReadIntOverflows() public {
        vm.expectRevert(abi.encodeWithSelector(SafeCast.SafeCastOverflowedUintToInt.selector, 2 ** 255));
        harness.readInt(bytes.concat('{"value":', bytes(vm.toString(uint256(2 ** 255))), "}"), "value", 0);
    }

    function test_RevertWhen_ABoolIsExpectedButTheValueIsNot() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "isFinal"));
        harness.readBool('{"isFinal":1}', "isFinal");
    }

    function test_RevertWhen_AStringIsExpectedButTheValueIsNot() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.UnexpectedValue.selector, "category"));
        harness.readString('{"category":1}', "category");
    }

    function test_RevertWhen_TheDataIsNotAnObject() public {
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "price"));
        harness.readUint("[1]", "price", 0);
        vm.expectRevert(abi.encodeWithSelector(ProjectedJson.FieldNotFound.selector, "price"));
        harness.readUint("2443.95", "price", 0);
    }

    function test_EscapePointerToken_EscapesSlashes() public pure {
        assertEq(ProjectedJson.escapePointerToken("ETH/USD"), "ETH~1USD");
    }

    function test_EscapePointerToken_EscapesTildesBeforeSlashes() public pure {
        assertEq(ProjectedJson.escapePointerToken("a~/b"), "a~0~1b");
        assertEq(ProjectedJson.escapePointerToken("~1"), "~01");
    }

    function test_EscapePointerToken_LeavesOtherKeysAsTheyAre() public pure {
        assertEq(ProjectedJson.escapePointerToken("BTC-USD"), "BTC-USD");
        assertEq(ProjectedJson.escapePointerToken(""), "");
    }

    function testFuzz_ReadUint_ReadsAnyInteger(uint256 value) public view {
        assertEq(harness.readUint(bytes.concat('{"value":', bytes(vm.toString(value)), "}"), "value", 0), value);
    }

    function testFuzz_ReadUint_ReadsAnyIntegerInAString(uint256 value) public view {
        bytes memory json = bytes.concat('{"value":"', bytes(vm.toString(value)), '"}');
        assertEq(harness.readUint(json, "value", 0), value);
    }

    function testFuzz_ReadInt_ReadsAnyInteger(int256 value) public view {
        vm.assume(value != type(int256).min);
        assertEq(harness.readInt(bytes.concat('{"value":', bytes(vm.toString(value)), "}"), "value", 0), value);
    }

    function testFuzz_ReadUint_ScalesIntegersToDecimals(uint128 value, uint8 decimals) public view {
        decimals = uint8(bound(decimals, 0, 36));
        bytes memory json = bytes.concat('{"value":', bytes(vm.toString(value)), "}");
        assertEq(harness.readUint(json, "value", decimals), uint256(value) * 10 ** decimals);
    }
}
