#!/usr/bin/env bash
# FreeCompare Integration Guard for Antigravity (agy) CLI PreToolUse Hook
# Forwards directly to native cross-platform `fcompare guard` command.
exec fcompare guard "$@"
