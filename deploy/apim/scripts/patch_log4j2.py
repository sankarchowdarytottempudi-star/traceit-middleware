#!/usr/bin/env python3
"""Derive green's log4j2.properties from the file that ships in the image.

  patch_log4j2.py <image log4j2.properties> <out log4j2.properties>

The image file already contains everything native analytics needs (appender
APIM_METRICS_APPENDER -> repository/logs/apim_metrics.log and logger
org.wso2.am.analytics.publisher.reporter.elk). The only thing it lacks is a bound on disk use:
every date-based RollingFile appender keeps its rolled files for ever. This script adds a log4j2
`Delete` action to each of those appenders (rolled files older than MAX_AGE, or beyond a total
size cap, are removed at rollover) and lowers the two 1000MB size triggers. Nothing else changes.
"""
from __future__ import annotations
import re, sys

MAX_AGE = "P14D"
SIZE_CAP = {"APIM_METRICS_APPENDER": "2GB", "APIM_GATEWAY_ACCESS_APPENDER": "1GB",
            "CARBON_LOGFILE": "500MB"}
DEFAULT_CAP = "200MB"
SIZE_TRIGGER = {"APIM_METRICS_APPENDER": "100MB", "APIM_GATEWAY_ACCESS_APPENDER": "100MB"}
ROLL_MAX = {"APIM_METRICS_APPENDER": "20", "APIM_GATEWAY_ACCESS_APPENDER": "20"}


def rolled_regex(file_pattern):
    """Regex (no backslashes: this goes into a .properties file) matching only ROLLED files."""
    name = file_pattern.strip().rsplit("/", 1)[1]
    out, i = "", 0
    for m in re.finditer(r"%d\{([^}]*)\}|%i", name):
        out += re.sub(r"([.+*?()\[\]{}|^$])", r"[\1]", name[i:m.start()])
        if m.group(0) == "%i":
            out += "[0-9]+"
        else:
            out += re.sub(r"[A-Za-z]+", lambda x: "[0-9]{%d}" % len(x.group(0)), m.group(1))
        i = m.end()
    return out + re.sub(r"([.+*?()\[\]{}|^$])", r"[\1]", name[i:])


def main(src, dst):
    lines = open(src).read().split("\n")
    patterns = {}
    for l in lines:
        m = re.match(r"^appender\.(\w+)\.filePattern\s*=\s*(.+)$", l)
        if m:
            patterns[m.group(1)] = m.group(2)
    out, done = [], []
    for l in lines:
        m = re.match(r"^appender\.(\w+)\.policies\.size\.size\s*=", l)
        if m and m.group(1) in SIZE_TRIGGER:
            l = f"appender.{m.group(1)}.policies.size.size = {SIZE_TRIGGER[m.group(1)]}"
        m = re.match(r"^appender\.(\w+)\.strategy\.max\s*=", l)
        if m and m.group(1) in ROLL_MAX:
            l = f"appender.{m.group(1)}.strategy.max = {ROLL_MAX[m.group(1)]}"
        out.append(l)
        m = re.match(r"^appender\.(\w+)\.strategy\.type\s*=\s*DefaultRolloverStrategy\s*$", l)
        if m and "%d" in patterns.get(m.group(1), ""):
            a = m.group(1)
            p = f"appender.{a}.strategy.delete"
            out += [
                "# weave: keep disk use bounded - delete rolled files that are too old or beyond the size cap",
                f"{p}.type = Delete",
                f"{p}.basePath = ${{sys:carbon.home}}/repository/logs",
                f"{p}.maxDepth = 1",
                f"{p}.ifFileName.type = IfFileName",
                f"{p}.ifFileName.regex = {rolled_regex(patterns[a])}",
                f"{p}.ifFileName.ifAny.type = IfAny",
                f"{p}.ifFileName.ifAny.ifLastModified.type = IfLastModified",
                f"{p}.ifFileName.ifAny.ifLastModified.age = {MAX_AGE}",
                f"{p}.ifFileName.ifAny.ifAccumulatedFileSize.type = IfAccumulatedFileSize",
                f"{p}.ifFileName.ifAny.ifAccumulatedFileSize.exceeds = {SIZE_CAP.get(a, DEFAULT_CAP)}",
            ]
            done.append(a)
    open(dst, "w").write("\n".join(out))
    print(f"Delete-on-rollover added to {len(done)} appenders: {', '.join(done)}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
