#!/usr/bin/env bash
# Activate the cost allocation tag "Project" (takes up to 24 h to appear in Cost Explorer; do it on day 0).
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
require aws
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active
log "requested activation of cost allocation tag Project"
