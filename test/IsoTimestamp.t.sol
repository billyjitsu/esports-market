// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DateTimeLib} from "solady/utils/DateTimeLib.sol";
import {LibString} from "solady/utils/LibString.sol";
import {IsoTimestamp} from "../contracts/IsoTimestamp.sol";

// The library function is internal, so the tests call it through a contract, where expectRevert can catch a revert.
contract IsoTimestampHarness {
    function parse(string calldata text) external pure returns (uint256) {
        return IsoTimestamp.parse(text);
    }
}

contract IsoTimestampTest is Test {
    IsoTimestampHarness harness = new IsoTimestampHarness();

    function test_Parse_ReadsADateTimeInUtc() public view {
        // Polymarket's endDate, and an AeroDataBox time, which has a space and no seconds
        assertEq(harness.parse("2024-11-05T12:00:00Z"), 1730808000);
        assertEq(harness.parse("2026-10-23 08:55Z"), 1792745700);
    }

    function test_Parse_AppliesTheOffset() public view {
        // AeroDataBox's local times of a flight that leaves Frankfurt at 08:55Z and lands in New York at 17:35Z
        assertEq(harness.parse("2026-10-23 10:55+02:00"), 1792745700);
        assertEq(harness.parse("2026-10-23 13:35-04:00"), 1792776900);
        assertEq(harness.parse("2026-10-23T14:25+05:30"), 1792745700);
        assertEq(harness.parse("2026-10-23T10:55+0200"), 1792745700);
        // Polymarket's closedTime has only hours in its offset
        assertEq(harness.parse("2024-11-06 15:17:41+00"), 1730906261);
        assertEq(harness.parse("1970-01-01T01:00+01:00"), 0);
    }

    function test_Parse_ReadsADateAsItsMidnightInUtc() public view {
        assertEq(harness.parse("2024-11-05"), 1730764800);
        assertEq(harness.parse("2024-02-29"), 1709164800);
        assertEq(harness.parse("1970-01-01"), 0);
    }

    function test_Parse_CutsOffFractionsOfASecond() public view {
        assertEq(harness.parse("2026-10-23T08:55:30.999Z"), 1792745730);
        assertEq(harness.parse("2026-10-23T10:55:30.123456789+02:00"), 1792745730);
    }

    function test_RevertWhen_TheTimeIsBefore1970() public {
        // A Unix timestamp in a uint256 starts at 1970-01-01T00:00Z.
        string[3] memory values = ["1969-12-31", "1969-12-31T23:59:59Z", "1970-01-01T00:30+01:00"];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(IsoTimestamp.InvalidTimestamp.selector, values[index]));
            harness.parse(values[index]);
        }
    }

    function test_RevertWhen_TheTextIsNotATimestampThatParseReads() public {
        string[23] memory values = [
            // A date-time without an offset is a local time of an unknown place.
            "2024-11-05T12:00:00",
            "2024-11-05 12:00",
            "2024-13-01",
            "2024-02-30",
            "2023-02-29",
            "2024-11-5",
            "24-11-05",
            "2024/11/05",
            "2024-11-05 ",
            "2024-11-05X12:00Z",
            "2024-11-05T12Z",
            "2024-11-05T24:00Z",
            "2024-11-05T12:60Z",
            "2024-11-05T23:59:60Z",
            "2024-11-05T12:00.5Z",
            "2024-11-05T12:00:00.Z",
            "2024-11-05T12:00z",
            "2024-11-05T12:00 Z",
            "2024-11-05T12:00+2",
            "2024-11-05T12:00+02:0",
            "2024-11-05T12:00+24:00",
            "2024-11-05T12:00+02:00Z",
            ""
        ];
        for (uint256 index = 0; index < values.length; index++) {
            vm.expectRevert(abi.encodeWithSelector(IsoTimestamp.InvalidTimestamp.selector, values[index]));
            harness.parse(values[index]);
        }
    }

    function testFuzz_Parse_ReadsAnyTimeWithAnyOffset(uint256 timestamp, uint256 offsetMinutes, bool isAheadOfUtc)
        public
        view
    {
        offsetMinutes = bound(offsetMinutes, 0, 23 * 60 + 59);
        uint256 offset = offsetMinutes * 1 minutes;
        // Up to 9999-12-31T23:59:59Z, the last time with a four-digit year
        timestamp = bound(timestamp, offset, 253402300799 - offset);
        uint256 localTimestamp = isAheadOfUtc ? timestamp + offset : timestamp - offset;
        string memory offsetText = string.concat(
            isAheadOfUtc ? "+" : "-", padDigits(offsetMinutes / 60, 2), ":", padDigits(offsetMinutes % 60, 2)
        );
        assertEq(harness.parse(string.concat(formatLocalTime(localTimestamp), offsetText)), timestamp);
    }

    function formatLocalTime(uint256 timestamp) private pure returns (string memory) {
        (uint256 year, uint256 month, uint256 day) = DateTimeLib.timestampToDate(timestamp);
        uint256 secondsIntoDay = timestamp % 1 days;
        string memory date = string.concat(padDigits(year, 4), "-", padDigits(month, 2), "-", padDigits(day, 2));
        string memory time = string.concat(
            padDigits(secondsIntoDay / 1 hours, 2),
            ":",
            padDigits((secondsIntoDay % 1 hours) / 1 minutes, 2),
            ":",
            padDigits(secondsIntoDay % 1 minutes, 2)
        );
        return string.concat(date, "T", time);
    }

    function padDigits(uint256 value, uint256 length) private pure returns (string memory) {
        string memory digits = LibString.toString(value);
        return string.concat(LibString.repeat("0", length - bytes(digits).length), digits);
    }
}
