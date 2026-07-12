#!/usr/bin/env bash
#
# scripts/release-branch.sh - Create a new release branch from master (generic)
#
# Usage:
#   bash scripts/release-branch.sh 0.7.0   # With version argument
#   bash scripts/release-branch.sh          # Interactive (asks for version)
#

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
step()    { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

confirm() {
    local message="$1"
    local default="${2:-n}"

    if [[ "$default" == "y" ]]; then
        echo -ne "${YELLOW}${message} (Y/n): ${NC}"
    else
        echo -ne "${YELLOW}${message} (y/N): ${NC}"
    fi

    read -r answer
    answer="${answer:-$default}"
    [[ "$answer" =~ ^[Yy]$ ]]
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    local pkg_name
    pkg_name=$(node -p "require('./package.json').name" 2>/dev/null || echo "unknown")

    local title="${pkg_name} Release Branch Creator"
    local width=${#title}
    local border
    border=$(printf '═%.0s' $(seq 1 $((width + 4))))
    echo -e "${CYAN}"
    echo "╔${border}╗"
    echo "║  ${title}  ║"
    echo "╚${border}╝"
    echo -e "${NC}"

    local target_version="${1:-}"

    # Show current version
    step "Current state"
    local current_version
    current_version=$(node -p "require('./package.json').version" 2>/dev/null || echo "unknown")
    info "Current version: $current_version"

    # Get target version
    if [[ -z "$target_version" ]]; then
        echo -ne "${YELLOW}Target version (e.g. 0.7.0): ${NC}"
        read -r target_version
    fi

    # Validate semver format
    if [[ ! "$target_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        error "Invalid version format: $target_version (expected: X.Y.Z)"
        exit 1
    fi

    local branch_name="release-v${target_version}"

    # Check if branch already exists (local or remote)
    step "Checking branch availability"

    if git rev-parse --verify "$branch_name" &>/dev/null; then
        error "Local branch '$branch_name' already exists!"
        exit 1
    fi

    if git ls-remote --heads origin "$branch_name" 2>/dev/null | grep -q "$branch_name"; then
        error "Remote branch '$branch_name' already exists!"
        exit 1
    fi

    success "Branch name '$branch_name' is available"

    # Check clean working tree
    if [[ -n "$(git status --porcelain)" ]]; then
        error "You have uncommitted changes. Please commit or stash them first."
        git status --short
        exit 1
    fi

    # Fetch and create branch
    step "Creating branch"

    info "Fetching latest master..."
    git fetch origin master --quiet

    git checkout -b "$branch_name" origin/master
    success "Branch created: $branch_name"

    # Optional: create initial changeset
    step "Initial changeset"

    if confirm "Create an initial changeset now?" "y"; then
        bunx changeset
    else
        info "You can create changesets later with: bunx changeset"
    fi

    # Optional: push to remote
    step "Push to remote"

    if confirm "Push branch to remote?" "y"; then
        git push -u origin "$branch_name"
        success "Branch pushed to remote"
    else
        info "You can push later with: git push -u origin $branch_name"
    fi

    # Done
    echo ""
    success "Release branch is ready!"
    echo ""
    info "Next steps:"
    info "  1. Develop on this branch"
    info "  2. Add changesets for each significant change: bunx changeset"
    info "  3. When ready to release: bash scripts/release.sh"
    echo ""
}

main "$@"
