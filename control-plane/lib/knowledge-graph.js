'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_NODES = 10000;
const MAX_EDGES = 50000;

function createKnowledgeGraph(opts = {}) {
  const dataDir = opts.dataDir || null;
  const nodes = new Map();   // id -> GraphNode
  const edges = new Map();   // id -> GraphEdge
  const adjacency = new Map(); // nodeId -> Set<edgeId>

  // Load persisted graph from disk
  if (dataDir) {
    const graphPath = path.join(dataDir, 'knowledge', 'graph.json');
    try {
      const raw = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
      if (Array.isArray(raw.nodes)) {
        for (const n of raw.nodes) {
          if (n && n.id && nodes.size < MAX_NODES) nodes.set(n.id, n);
        }
      }
      if (Array.isArray(raw.edges)) {
        for (const e of raw.edges) {
          if (e && e.id && edges.size < MAX_EDGES) {
            edges.set(e.id, e);
            _addAdjacency(e);
          }
        }
      }
    } catch { /* no persisted graph yet */ }
  }

  function _addAdjacency(edge) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, new Set());
    if (!adjacency.has(edge.target)) adjacency.set(edge.target, new Set());
    adjacency.get(edge.source).add(edge.id);
    adjacency.get(edge.target).add(edge.id);
  }

  function _removeAdjacency(edge) {
    const srcSet = adjacency.get(edge.source);
    if (srcSet) { srcSet.delete(edge.id); if (srcSet.size === 0) adjacency.delete(edge.source); }
    const tgtSet = adjacency.get(edge.target);
    if (tgtSet) { tgtSet.delete(edge.id); if (tgtSet.size === 0) adjacency.delete(edge.target); }
  }

  function _evictOldestNodes(count) {
    const sorted = [...nodes.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < count && i < sorted.length; i++) {
      const id = sorted[i].id;
      // Remove edges connected to this node without persisting each time
      const edgeIds = adjacency.get(id);
      if (edgeIds) {
        for (const eid of [...edgeIds]) {
          const edge = edges.get(eid);
          if (edge) {
            _removeAdjacency(edge);
            edges.delete(eid);
          }
        }
      }
      adjacency.delete(id);
      nodes.delete(id);
    }
    _persist(); // Single persist after batch eviction
  }

  function _evictOldestEdges(count) {
    const sorted = [...edges.values()].sort((a, b) => a.createdAt - b.createdAt);
    for (let i = 0; i < count && i < sorted.length; i++) {
      const edge = sorted[i];
      _removeAdjacency(edge);
      edges.delete(edge.id);
    }
    _persist(); // Single persist after batch eviction
  }

  function _persist() {
    if (!dataDir) return;
    const dir = path.join(dataDir, 'knowledge');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const graphPath = path.join(dir, 'graph.json');
    const tmpPath = graphPath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ nodes: [...nodes.values()], edges: [...edges.values()] }));
      fs.renameSync(tmpPath, graphPath);
    } catch { /* ignore write errors */ }
  }

  function addNode(node) {
    if (!node || !node.id) throw new Error('Node must have an id');
    // Dedup: update if exists
    if (nodes.has(node.id)) {
      const existing = nodes.get(node.id);
      nodes.set(node.id, { ...existing, ...node, updatedAt: node.updatedAt || Date.now() });
      _persist();
      return nodes.get(node.id);
    }
    // Evict oldest if at capacity
    if (nodes.size >= MAX_NODES) {
      _evictOldestNodes(1);
    }
    const now = Date.now();
    const stored = {
      id: node.id,
      type: node.type || 'file',
      label: node.label || node.id,
      metadata: node.metadata || {},
      createdAt: node.createdAt || now,
      updatedAt: node.updatedAt || now
    };
    nodes.set(stored.id, stored);
    _persist();
    return stored;
  }

  function removeNode(id) {
    if (!nodes.has(id)) return false;
    // Remove all edges connected to this node
    const edgeIds = adjacency.get(id);
    if (edgeIds) {
      for (const eid of [...edgeIds]) {
        removeEdge(eid);
      }
    }
    adjacency.delete(id);
    nodes.delete(id);
    _persist();
    return true;
  }

  function getNode(id) {
    return nodes.get(id) || null;
  }

  function addEdge(edge) {
    if (!edge || !edge.source || !edge.target) throw new Error('Edge must have source and target');
    const id = edge.id || (edge.source + ':' + edge.target);
    // Dedup: update if exists
    if (edges.has(id)) {
      const existing = edges.get(id);
      edges.set(id, { ...existing, ...edge, id });
      _persist();
      return edges.get(id);
    }
    // Evict oldest if at capacity
    if (edges.size >= MAX_EDGES) {
      _evictOldestEdges(1);
    }
    const now = Date.now();
    const stored = {
      id,
      source: edge.source,
      target: edge.target,
      type: edge.type || 'related',
      weight: edge.weight || 1,
      metadata: edge.metadata || {},
      createdAt: edge.createdAt || now
    };
    edges.set(id, stored);
    _addAdjacency(stored);
    _persist();
    return stored;
  }

  function removeEdge(id) {
    const edge = edges.get(id);
    if (!edge) return false;
    _removeAdjacency(edge);
    edges.delete(id);
    _persist();
    return true;
  }

  function getEdge(id) {
    return edges.get(id) || null;
  }

  function getNeighbors(nodeId, opts = {}) {
    const depth = opts.depth || 1;
    const types = opts.types || null;
    const visited = new Set();
    const result = [];
    let frontier = [nodeId];
    visited.add(nodeId);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        const edgeIds = adjacency.get(nid);
        if (!edgeIds) continue;
        for (const eid of edgeIds) {
          const edge = edges.get(eid);
          if (!edge) continue;
          const neighborId = edge.source === nid ? edge.target : edge.source;
          if (visited.has(neighborId)) continue;
          const neighbor = nodes.get(neighborId);
          if (!neighbor) continue;
          visited.add(neighborId);
          // Always traverse through all nodes, but only include matching types in results
          if (!types || types.includes(neighbor.type)) {
            result.push(neighbor);
          }
          nextFrontier.push(neighborId);
        }
      }
      frontier = nextFrontier;
    }
    return result;
  }

  function listNodes(filters = {}) {
    let result = [...nodes.values()];
    if (filters.type) result = result.filter(n => n.type === filters.type);
    return result;
  }

  function listEdges(filters = {}) {
    let result = [...edges.values()];
    if (filters.type) result = result.filter(e => e.type === filters.type);
    if (filters.source) result = result.filter(e => e.source === filters.source);
    if (filters.target) result = result.filter(e => e.target === filters.target);
    return result;
  }

  function search(query) {
    if (!query) return [];
    const q = query.toLowerCase();
    return [...nodes.values()].filter(n => n.label.toLowerCase().includes(q));
  }

  function getStats() {
    const byType = {};
    for (const n of nodes.values()) {
      byType[n.type] = (byType[n.type] || 0) + 1;
    }
    // Connected components via union-find
    const parent = {};
    function find(x) {
      if (!parent[x]) parent[x] = x;
      while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
      return x;
    }
    function union(a, b) { parent[find(a)] = find(b); }

    for (const n of nodes.values()) parent[n.id] = n.id;
    for (const e of edges.values()) {
      if (nodes.has(e.source) && nodes.has(e.target)) union(e.source, e.target);
    }
    const roots = new Set();
    for (const id of nodes.keys()) roots.add(find(id));

    return {
      nodeCount: nodes.size,
      edgeCount: edges.size,
      byType,
      connectedComponents: roots.size
    };
  }

  function ingestFromEvents(eventList) {
    if (!Array.isArray(eventList)) return { nodesAdded: 0, edgesAdded: 0 };
    let nodesAdded = 0;
    let edgesAdded = 0;
    const now = Date.now();

    for (const event of eventList) {
      if (!event) continue;
      // Extract session node
      if (event.sessionId) {
        if (!nodes.has('session:' + event.sessionId)) {
          addNode({ id: 'session:' + event.sessionId, type: 'session', label: event.sessionId, metadata: { nodeId: event.nodeId }, createdAt: now });
          nodesAdded++;
        }
      }
      // Extract node agent
      if (event.nodeId) {
        if (!nodes.has('agent:' + event.nodeId)) {
          addNode({ id: 'agent:' + event.nodeId, type: 'agent', label: event.nodeId, metadata: {}, createdAt: now });
          nodesAdded++;
        }
        if (event.sessionId) {
          const edgeId = 'agent:' + event.nodeId + ':session:' + event.sessionId;
          if (!edges.has(edgeId)) {
            addEdge({ id: edgeId, source: 'agent:' + event.nodeId, target: 'session:' + event.sessionId, type: 'uses', weight: 1, createdAt: now });
            edgesAdded++;
          }
        }
      }
      // Extract file references from payload
      if (event.payload && typeof event.payload === 'object') {
        const filePath = event.payload.file || event.payload.path || event.payload.filePath;
        if (filePath && typeof filePath === 'string') {
          const fileId = 'file:' + filePath;
          if (!nodes.has(fileId)) {
            addNode({ id: fileId, type: 'file', label: filePath, metadata: {}, createdAt: now });
            nodesAdded++;
          }
          if (event.sessionId) {
            const edgeType = event.type === 'file_write' ? 'modifies' : 'references';
            const edgeId = 'session:' + event.sessionId + ':' + fileId;
            if (!edges.has(edgeId)) {
              addEdge({ id: edgeId, source: 'session:' + event.sessionId, target: fileId, type: edgeType, weight: 1, createdAt: now });
              edgesAdded++;
            }
          }
        }
        // Extract tool references
        const tool = event.payload.tool || event.payload.toolName;
        if (tool && typeof tool === 'string') {
          const toolId = 'tool:' + tool;
          if (!nodes.has(toolId)) {
            addNode({ id: toolId, type: 'tool', label: tool, metadata: {}, createdAt: now });
            nodesAdded++;
          }
          if (event.sessionId) {
            const edgeId = 'session:' + event.sessionId + ':' + toolId;
            if (!edges.has(edgeId)) {
              addEdge({ id: edgeId, source: 'session:' + event.sessionId, target: toolId, type: 'uses', weight: 1, createdAt: now });
              edgesAdded++;
            }
          }
        }
      }
    }
    return { nodesAdded, edgesAdded };
  }

  function getSubgraph(nodeId, depth = 2) {
    const visited = new Set();
    const subNodes = [];
    const subEdges = [];
    let frontier = [nodeId];
    visited.add(nodeId);
    const root = nodes.get(nodeId);
    if (root) subNodes.push(root);

    for (let d = 0; d < depth; d++) {
      const nextFrontier = [];
      for (const nid of frontier) {
        const edgeIds = adjacency.get(nid);
        if (!edgeIds) continue;
        for (const eid of edgeIds) {
          const edge = edges.get(eid);
          if (!edge) continue;
          // Include edge if at least one end is in frontier
          if (!subEdges.find(e => e.id === eid)) subEdges.push(edge);
          const neighborId = edge.source === nid ? edge.target : edge.source;
          if (visited.has(neighborId)) continue;
          visited.add(neighborId);
          const neighbor = nodes.get(neighborId);
          if (neighbor) {
            subNodes.push(neighbor);
            nextFrontier.push(neighborId);
          }
        }
      }
      frontier = nextFrontier;
    }
    return { nodes: subNodes, edges: subEdges };
  }

  function toJSON() {
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  function getCluster(type) {
    const clusterNodes = [...nodes.values()].filter(n => n.type === type);
    const nodeIds = new Set(clusterNodes.map(n => n.id));
    const clusterEdges = [...edges.values()].filter(e => nodeIds.has(e.source) || nodeIds.has(e.target));
    return { nodes: clusterNodes, edges: clusterEdges };
  }

  function getMostConnected(limit = 10) {
    const counts = {};
    for (const e of edges.values()) {
      counts[e.source] = (counts[e.source] || 0) + 1;
      counts[e.target] = (counts[e.target] || 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, edgeCount]) => ({ node: nodes.get(id) || { id }, edgeCount }));
  }

  return {
    addNode,
    removeNode,
    getNode,
    addEdge,
    removeEdge,
    getEdge,
    getNeighbors,
    listNodes,
    listEdges,
    search,
    getStats,
    ingestFromEvents,
    getSubgraph,
    toJSON,
    getCluster,
    getMostConnected
  };
}

module.exports = { createKnowledgeGraph };
