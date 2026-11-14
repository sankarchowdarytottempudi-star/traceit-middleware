#!/usr/bin/env bash
# Runs INSIDE the apim-tools pod (same image as APIM, so the exact H2 version APIM uses).
# Usage: h2q.sh <path/to/DBNAME (no .mv.db)> <file.sql>      DB password is read from stdin.
set -euo pipefail
read -r DBP
H2=$(ls /home/wso2carbon/wso2am-4.5.0/repository/components/plugins/h2-engine*.jar)
exec java -Xmx512m -cp "$H2" org.h2.tools.RunScript \
  -url "jdbc:h2:$1;IFEXISTS=TRUE" -user wso2carbon -password "$DBP" -script "$2" -showResults
