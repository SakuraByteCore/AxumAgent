/** Record envelopes establish nodes. A retained index avoids scanning nodes in long-lived folds. */
export function withSessionNode(graph, id, nodeIds) {
    if (nodeIds?.has(id) ?? graph.nodes.some((node) => node.id === id)) {
        return graph;
    }
    nodeIds?.add(id);
    return { ...graph, nodes: [...graph.nodes, { id }] };
}
/** The same native edge may be reported many times; the graph contains it once. */
export function withSessionLink(graph, edge, nodeIds) {
    const nodes = withSessionNode(withSessionNode(graph, edge.parent, nodeIds), edge.child, nodeIds);
    return nodes.edges.some((known) => known.parent === edge.parent && known.child === edge.child)
        ? nodes : { ...nodes, edges: [...nodes.edges, { parent: edge.parent, child: edge.child, via: edge.via }] };
}
/** One record's graph facts, shared by the retained live graph and batch replay. */
export function withSessionRecord(graph, record, nodeIds) {
    let next = withSessionNode(graph, record.sessionId, nodeIds);
    if (record.kind === "frame") {
        for (const event of record.body.events) {
            if (event.kind === "session_linked") {
                next = withSessionLink(next, event, nodeIds);
            }
        }
    }
    return next;
}
/**
 * True sessions observed in records, with only runtime-reported lineage.
 * Foreign session ids establish nodes, never edges. Old logs without
 * `session_linked` therefore have no edges; an empty log has no nodes.
 */
export function graphOf(records) {
    let graph = { nodes: [], edges: [] };
    const nodeIds = new Set();
    for (const record of records) {
        graph = withSessionRecord(graph, record, nodeIds);
    }
    return graph;
}
