export function parseGitlinkPaths(indexEntries) {
  return indexEntries
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^160000 [0-9a-f]+ \d+\t(.+)$/);
      return match ? [match[1]] : [];
    });
}
