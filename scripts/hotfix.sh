#!/usr/bin/env bash
#
# scripts/hotfix.sh - Hotfix workflow (auto-detects package from package.json)
#
# Usage:
#   bash scripts/hotfix.sh            # Create a hotfix branch
#   bash scripts/hotfix.sh --release  # Prepare hotfix release (delegates to release.sh)
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

# ─── Create hotfix branch ───────────────────────────────────────────────────

create_hotfix() {
    step "Creating hotfix branch"

    # Check clean working tree
    if [[ -n "$(git status --porcelain)" ]]; then
        error "You have uncommitted changes. Please commit or stash them first."
        git status --short
        exit 1
    fi

    # Fetch master
    info "Fetching latest master..."
    git fetch origin master --quiet

    # Get version from master's package.json
    local master_version
    master_version=$(git show origin/master:package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")

    # Calculate next patch version
    local major minor patch
    IFS='.' read -r major minor patch <<< "$master_version"
    local next_patch=$((patch + 1))
    local hotfix_version="${major}.${minor}.${next_patch}"
    local branch_name="hotfix-v${hotfix_version}"

    info "Master version: $master_version"
    info "Hotfix version: $hotfix_version"

    # Check if branch already exists
    if git rev-parse --verify "$branch_name" &>/dev/null; then
        error "Local branch '$branch_name' already exists!"
        exit 1
    fi

    if git ls-remote --heads origin "$branch_name" 2>/dev/null | grep -q "$branch_name"; then
        error "Remote branch '$branch_name' already exists!"
        exit 1
    fi

    # Create branch
    git checkout -b "$branch_name" origin/master
    success "Hotfix branch created: $branch_name"

    # Push to remote
    if confirm "Push branch to remote?" "y"; then
        git push -u origin "$branch_name"
        success "Branch pushed to remote"
    fi

    echo ""
    success "Hotfix branch is ready!"
    echo ""
    info "Next steps:"
    info "  1. Make your fix and commit it"
    info "  2. Add a changeset: bunx changeset (select 'patch')"
    info "  3. Release: bash scripts/hotfix.sh --release"
    echo ""
}

# ─── Release hotfix ─────────────────────────────────────────────────────────

release_hotfix() {
    local current_branch
    current_branch=$(git branch --show-current)

    if [[ ! "$current_branch" =~ ^hotfix-v ]]; then
        error "This command can only run on hotfix branches (hotfix-v*)"
        error "Current branch: $current_branch"
        exit 1
    fi

    info "Delegating to release.sh for hotfix release..."
    echo ""

    # Set env var so release.sh accepts hotfix branches
    ALLOW_HOTFIX=1 bash "$(dirname "$0")/release.sh" "${@}"
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    local pkg_name
    pkg_name=$(node -p "require('./package.json').name" 2>/dev/null || echo "unknown")

    local title="${pkg_name} Hotfix Workflow"
    local width=${#title}
    local border
    border=$(printf '═%.0s' $(seq 1 $((width + 4))))
    echo -e "${CYAN}"
    echo "╔${border}╗"
    echo "║  ${title}  ║"
    echo "╚${border}╝"
    echo -e "${NC}"

    if [[ "${1:-}" == "--release" ]]; then
        shift
        release_hotfix "$@"
    else
        create_hotfix
    fi
}

main "$@"
