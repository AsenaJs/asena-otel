#!/usr/bin/env bash
#
# scripts/release.sh - Release Automation (auto-detects package from package.json)
#
# Usage:
#   bash scripts/release.sh            # Full release flow
#   bash scripts/release.sh --dry-run  # Check only, no changes
#
# This script must be run from a release branch (release-v*) or hotfix branch (hotfix-v*).
# It does NOT publish to npm — run 'bun run release' manually after this script completes.
#

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Output helpers ──────────────────────────────────────────────────────────

info()    { echo -e "${BLUE}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}[OK]${NC} $1"; }
warn()    { echo -e "${YELLOW}[WARN]${NC} $1"; }
error()   { echo -e "${RED}[ERROR]${NC} $1"; }
step()    { echo -e "\n${CYAN}━━━ $1 ━━━${NC}"; }

# ─── Globals ─────────────────────────────────────────────────────────────────

DRY_RUN=false
RELEASE_BRANCH=""
OLD_VERSION=""
NEW_VERSION=""
TAG_NAME=""
PKG_NAME=$(node -p "require('./package.json').name" 2>/dev/null || echo "unknown")

# ─── Parse args ──────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    warn "DRY-RUN mode active. No changes will be made."
    echo ""
fi

# ─── Confirmation prompt ─────────────────────────────────────────────────────

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

# ─── Pre-flight checks ──────────────────────────────────────────────────────

check_tools() {
    step "Checking required tools"

    local missing=false
    for cmd in git bun bunx; do
        if ! command -v "$cmd" &>/dev/null; then
            error "'$cmd' not found. Please install it first."
            missing=true
        fi
    done

    if [[ "$missing" == true ]]; then
        exit 1
    fi

    success "All required tools available (git, bun, bunx)"
}

check_working_tree() {
    step "Checking working tree"

    if [[ -n "$(git status --porcelain)" ]]; then
        error "You have uncommitted changes. Please commit or stash them first."
        git status --short
        exit 1
    fi

    success "Working tree is clean"
}

check_branch() {
    step "Checking branch"

    RELEASE_BRANCH=$(git branch --show-current)

    local valid=false
    if [[ "$RELEASE_BRANCH" =~ ^release-v ]]; then
        valid=true
    elif [[ "$RELEASE_BRANCH" =~ ^hotfix-v ]] && [[ "${ALLOW_HOTFIX:-0}" == "1" ]]; then
        valid=true
    fi

    if [[ "$valid" == false ]]; then
        error "This script can only run on release branches (release-v*)"
        error "Current branch: $RELEASE_BRANCH"
        info "To create a release branch: bash scripts/release-branch.sh <version>"
        exit 1
    fi

    success "Branch: $RELEASE_BRANCH"
}

check_remote() {
    step "Checking remote"

    if ! git ls-remote --exit-code origin &>/dev/null; then
        error "Remote 'origin' is not reachable."
        exit 1
    fi

    success "Remote 'origin' is reachable"
}

check_behind_master() {
    step "Checking sync with master"

    git fetch origin master --quiet 2>/dev/null || true

    local behind_count
    behind_count=$(git rev-list --count HEAD..origin/master 2>/dev/null || echo "0")

    if [[ "$behind_count" -gt 0 ]]; then
        warn "This branch is $behind_count commit(s) behind master."
        warn "It is recommended to merge master before releasing:"
        info "  git merge origin/master"
        echo ""

        if ! confirm "Continue anyway?"; then
            info "Aborting. Merge master first and try again."
            exit 1
        fi
    else
        success "Branch is up to date with master"
    fi
}

# ─── Changeset check ────────────────────────────────────────────────────────

check_changesets() {
    step "Checking changesets"

    local changeset_count
    changeset_count=$(find .changeset -name "*.md" ! -name "README.md" 2>/dev/null | wc -l | tr -d ' ')

    if [[ "$changeset_count" -eq 0 ]]; then
        warn "No pending changesets found."

        if confirm "Would you like to create one now?"; then
            bunx changeset

            # Re-check
            changeset_count=$(find .changeset -name "*.md" ! -name "README.md" 2>/dev/null | wc -l | tr -d ' ')
            if [[ "$changeset_count" -eq 0 ]]; then
                error "No changeset was created. Aborting."
                exit 1
            fi
        else
            error "Cannot release without changesets. Aborting."
            exit 1
        fi
    fi

    success "$changeset_count changeset(s) found"
    info "Changesets:"
    find .changeset -name "*.md" ! -name "README.md" -exec basename {} \;
}

# ─── Quality gates ───────────────────────────────────────────────────────────

run_quality_gates() {
    step "Running quality gates"

    if node -p "!!require('./package.json').scripts?.check" 2>/dev/null | grep -q "true"; then
        info "Running lint and format check..."
        if ! bun run check; then
            error "Lint/format errors found. Run 'bun run check:fix' to fix them."
            exit 1
        fi
        success "Lint and format checks passed"
    else
        warn "No 'check' script in package.json — skipping lint/format check"
    fi

    info "Running tests..."
    if ! bun test; then
        error "Tests failed. Please fix the failing tests."
        exit 1
    fi
    success "All tests passed"

    info "Building..."
    if ! bun run build; then
        error "Build failed. Please fix the build errors."
        exit 1
    fi
    success "Build successful"
}

# ─── Version bump ────────────────────────────────────────────────────────────

bump_version() {
    step "Bumping version"

    OLD_VERSION=$(node -p "require('./package.json').version")
    info "Current version: $OLD_VERSION"

    info "Running changeset version..."
    bunx changeset version

    NEW_VERSION=$(node -p "require('./package.json').version")

    if [[ "$OLD_VERSION" == "$NEW_VERSION" ]]; then
        warn "Version did not change ($OLD_VERSION). Changesets may not have been applied."

        if ! confirm "Continue anyway?"; then
            exit 1
        fi
    fi

    success "Version bumped: $OLD_VERSION -> $NEW_VERSION"
}

# ─── Commit & tag ────────────────────────────────────────────────────────────

commit_and_tag() {
    step "Commit & Tag"

    TAG_NAME="v${NEW_VERSION}"

    # Check if tag already exists
    if git rev-parse "$TAG_NAME" &>/dev/null; then
        error "Tag '$TAG_NAME' already exists!"
        error "This version may have already been released."
        exit 1
    fi

    echo ""
    info "┌───────────────────────────────────────────┐"
    info "│          RELEASE SUMMARY                  │"
    info "├───────────────────────────────────────────┤"
    info "│  Package:  $PKG_NAME"
    info "│  Version:  $OLD_VERSION -> $NEW_VERSION"
    info "│  Tag:      $TAG_NAME"
    info "│  Branch:   $RELEASE_BRANCH"
    info "└───────────────────────────────────────────┘"
    echo ""

    if [[ "$DRY_RUN" == true ]]; then
        warn "DRY-RUN: Skipping commit and tag."
        return 0
    fi

    if ! confirm "Commit version bump and create tag?"; then
        warn "Skipped. You can commit manually:"
        info "  git add package.json CHANGELOG.md .changeset/"
        info "  git commit -m \"chore(version): bump to $TAG_NAME\""
        info "  git tag -a $TAG_NAME -m \"Release $TAG_NAME\""
        exit 0
    fi

    git add package.json CHANGELOG.md .changeset/
    # Also stage bun.lock if it changed
    git diff --name-only | grep -q "bun.lock" && git add bun.lock || true
    git commit -m "chore(version): bump to ${TAG_NAME}"
    git tag -a "$TAG_NAME" -m "Release ${TAG_NAME}"

    success "Committed and tagged as $TAG_NAME"
}

# ─── Push ────────────────────────────────────────────────────────────────────

push_to_remote() {
    step "Push to remote"

    if [[ "$DRY_RUN" == true ]]; then
        warn "DRY-RUN: Skipping push."
        return 0
    fi

    if ! confirm "Push branch and tag to remote?"; then
        warn "Skipped. You can push manually:"
        info "  git push origin $RELEASE_BRANCH"
        info "  git push origin $TAG_NAME"
        return 0
    fi

    git push origin "$RELEASE_BRANCH"
    git push origin "$TAG_NAME"

    success "Pushed to remote"
}

# ─── Post-release ────────────────────────────────────────────────────────────

post_release() {
    step "Post-release"

    # Offer PR creation if gh CLI is available
    if command -v gh &>/dev/null; then
        echo ""
        if confirm "Create a pull request to master?" "y"; then
            gh pr create \
                --base master \
                --head "$RELEASE_BRANCH" \
                --title "Release ${TAG_NAME}" \
                --body "## Release ${TAG_NAME}

Auto-generated release PR.

### Checklist
- [ ] Review CHANGELOG.md
- [ ] Ensure CI checks pass
- [ ] Merge (use merge commit, not squash)"
            success "Pull request created!"
        fi
    else
        info "Tip: Install GitHub CLI (gh) to create PRs from this script."
        info "  https://cli.github.com/"
    fi

    echo ""
    echo -e "${GREEN}${BOLD}━━━ Release ${TAG_NAME} is ready! ━━━${NC}"
    echo ""
    info "Next steps:"
    info "  1. Merge the PR to master"
    info "  2. Publish to npm:  ${BOLD}bun run release${NC}"
    info "  3. Verify on npm:   https://www.npmjs.com/package/${PKG_NAME}"
    if command -v gh &>/dev/null; then
        info "  4. Create GitHub release (optional): gh release create ${TAG_NAME}"
    fi
    echo ""
}

# ─── Main ────────────────────────────────────────────────────────────────────

main() {
    local title="${PKG_NAME} Release Automation"
    local width=${#title}
    local border
    border=$(printf '═%.0s' $(seq 1 $((width + 4))))
    echo -e "${CYAN}"
    echo "╔${border}╗"
    echo "║  ${title}  ║"
    echo "╚${border}╝"
    echo -e "${NC}"

    # Pre-flight
    check_tools
    check_working_tree
    check_branch
    check_remote
    check_behind_master

    # Changesets
    check_changesets

    # Quality
    run_quality_gates

    # Version
    bump_version

    # Commit & tag
    commit_and_tag

    # Push
    push_to_remote

    # Done
    post_release
}

main "$@"
