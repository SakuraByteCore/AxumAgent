/** Add lineage to its first source frame, including at most one copy within that frame. */
export function newSessionLinks(kernel, edges) {
    const known = kernel.graph().edges;
    const added = [];
    for (const edge of edges) {
        const same = (candidate) => candidate.parent === edge.parent && candidate.child === edge.child;
        if (!known.some((candidate) => same(candidate)) && !added.some((candidate) => same(candidate))) {
            added.push(kernel.link(edge));
        }
    }
    return added;
}
