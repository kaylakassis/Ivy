#!/bin/sh
# Xcode Cloud: runs once, right after the repository is cloned and before
# any xcodebuild step. Lives in ios/App/ci_scripts because Xcode Cloud
# only looks for ci_scripts next to the .xcworkspace it was pointed at.
#
# Why this exists: Xcode Cloud knows how to build an Xcode project, not a
# Capacitor one. Two things the archive needs are deliberately NOT in git
# (see ios/.gitignore) and have to be produced on the build machine:
#   - ios/App/App/public   (the web bundle, copied from dist/ by cap sync)
#   - ios/App/Pods         (native deps, installed by pod install)
# Without this script the archive fails within seconds because the
# workspace references a Pods project that does not exist.
#
# Build-time env the web bundle needs (set these in the Xcode Cloud
# workflow > Environment > Environment Variables):
#   VITE_API_BASE_URL              https://www.joinivy.ai        (required)
#   VITE_REVENUECAT_PUBLIC_KEY_IOS appl_...                   (required to
#                                  submit for sale; build only warns)
# scripts/check-ios-env.mjs enforces the first and warns on the second.
set -e
set -x

# Skip Homebrew's self-update: it adds time and nothing we need.
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_ENV_HINTS=1

# Xcode Cloud images ship Homebrew (and CocoaPods), but not Node.
brew install node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version
npm --version
command -v pod >/dev/null 2>&1 || brew install cocoapods
pod --version

cd "$CI_PRIMARY_REPOSITORY_PATH"
npm ci --no-audit --no-fund

# Xcode Cloud leaves git settings on the machine from its own checkout
# that send github.com through a local proxy (localhost:8088) which is
# gone by now. Some pods (RevenueCat's PurchasesHybridCommon) are fetched
# with git clone, so pod install died with "Failed to connect to localhost
# port 8088" (build 189). Show which settings exist (names only, any
# login in a URL hidden), then run the sync without them: these pods are
# public, and everything else on this machine already downloads directly.
git config --show-origin --name-only --get-regexp '^(url\.|http\.)' 2>/dev/null \
  | sed -E 's#//[^/@[:space:]]*@#//***@#g' || true
env | grep -i '_proxy=' | sed -E 's/=.*/=(set)/' || true

# env preflight -> vite build -> copy into ios/ -> pod install
env -u http_proxy -u HTTP_PROXY -u https_proxy -u HTTPS_PROXY -u all_proxy -u ALL_PROXY \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  npm run ios:sync
