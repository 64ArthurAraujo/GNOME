#!/usr/bin/env bash

if [ -z "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" ]; then
  echo Cannot review non-merge request
  exit 1
fi

git fetch $CI_MERGE_REQUEST_PROJECT_URL.git $CI_MERGE_REQUEST_TARGET_BRANCH_NAME

branch_point=$(git merge-base HEAD FETCH_HEAD)

commits=$(git log --format='format:%H' $branch_point..$CI_COMMIT_SHA)

if [ -z "$commits" ]; then
  echo Commit range empty
  exit 1
fi

function commit_message_has_mr_url() {
  commit=$1
  commit_message=$(git show -s --format='format:%b' $commit)
  echo "$commit_message" | grep -qe "^$CI_MERGE_REQUEST_PROJECT_URL\/\(-\/\)\?merge_requests\/$CI_MERGE_REQUEST_IID$"
  return $?
}

for commit in $commits; do
  if commit_message_has_mr_url $commit; then
    echo "Commit $(echo $commit | cut -c -8) message must not contain a link to its own merge request"
    exit 1
  fi
done
