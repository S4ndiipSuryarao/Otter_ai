import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { Session, SessionStatus, STTProviderName, AgentInfo } from './types';
import { logger } from './index';

// ─── In-Memory Session Manager ───────────────────────────────────────────────
// Redis-compatible interface: swap out the Maps for ioredis calls to scale.

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, Session>();
  private agents = new Map<string, AgentInfo>();
  private waitingQueue: string[] = []; // sessionIds waiting for an agent

  // ─── Agent Management ───────────────────────────────────────────────────────

  registerAgent(agentId: string): void {
    this.agents.set(agentId, {
      id: agentId,
      activeSessions: [],
      maxSessions: 2,
      connectedAt: Date.now(),
    });
    logger.info({ agentId }, 'Agent registered');
    this.tryAssignQueued();
  }

  removeAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Mark all this agent's sessions as needing reassignment
    for (const sessionId of agent.activeSessions) {
      const session = this.sessions.get(sessionId);
      if (session && session.status === 'active') {
        session.agentId = null;
        session.status = 'waiting';
        this.waitingQueue.push(sessionId);
        this.emit('agent_disconnected', sessionId);
      }
    }

    this.agents.delete(agentId);
    logger.info({ agentId }, 'Agent removed');
    this.tryAssignQueued();
  }

  getAgent(agentId: string): AgentInfo | undefined {
    return this.agents.get(agentId);
  }

  getAllAgents(): AgentInfo[] {
    return Array.from(this.agents.values());
  }

  // ─── Session Management ──────────────────────────────────────────────────────

  createSession(userId: string): Session {
    const sessionId = randomUUID();
    const session: Session = {
      id: sessionId,
      userId,
      agentId: null,
      status: 'waiting',
      sttProvider: (process.env.STT_PRIMARY as STTProviderName) || 'deepgram',
      sttFallback: (process.env.STT_FALLBACK as STTProviderName) || 'google',
      language: 'en-US',
      createdAt: Date.now(),
      startedAt: null,
    };

    this.sessions.set(sessionId, session);
    this.waitingQueue.push(sessionId);
    logger.info({ sessionId, userId }, 'Session created, entering queue');

    this.tryAssignQueued();
    return session;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  getSessionByUserId(userId: string): Session | undefined {
    return Array.from(this.sessions.values()).find(s => s.userId === userId && s.status !== 'ended');
  }

  getSessionByAgentId(agentId: string): Session[] {
    return Array.from(this.sessions.values()).filter(s => s.agentId === agentId && s.status !== 'ended');
  }

  endSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Remove from agent's session list
    if (session.agentId) {
      const agent = this.agents.get(session.agentId);
      if (agent) {
        agent.activeSessions = agent.activeSessions.filter(id => id !== sessionId);
      }
    }

    // Remove from waiting queue
    this.waitingQueue = this.waitingQueue.filter(id => id !== sessionId);

    session.status = 'ended';
    this.emit('session_ended', sessionId);
    logger.info({ sessionId }, 'Session ended');

    // Clean up after 60s
    setTimeout(() => this.sessions.delete(sessionId), 60_000);
  }

  updateSessionSTTProvider(sessionId: string, provider: STTProviderName): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.sttProvider = provider;
    this.emit('stt_provider_changed', sessionId, provider);
    return true;
  }

  getQueueLength(): number {
    return this.waitingQueue.length;
  }

  getStats() {
    const active = Array.from(this.sessions.values()).filter(s => s.status === 'active').length;
    const waiting = this.waitingQueue.length;
    return {
      activeSessions: active,
      waitingUsers: waiting,
      connectedAgents: this.agents.size,
    };
  }

  // ─── Private: Assignment Logic ──────────────────────────────────────────────

  private tryAssignQueued(): void {
    while (this.waitingQueue.length > 0) {
      const agent = this.pickAvailableAgent();
      if (!agent) break;

      const sessionId = this.waitingQueue.shift()!;
      const session = this.sessions.get(sessionId);
      if (!session || session.status === 'ended') continue;

      session.agentId = agent.id;
      session.status = 'active';
      session.startedAt = Date.now();
      agent.activeSessions.push(sessionId);

      logger.info({ sessionId, agentId: agent.id }, 'Session assigned to agent');
      this.emit('session_assigned', sessionId, agent.id);
    }
  }

  /** Round-robin with capacity check */
  private pickAvailableAgent(): AgentInfo | null {
    let leastLoaded: AgentInfo | null = null;
    for (const agent of this.agents.values()) {
      if (agent.activeSessions.length >= agent.maxSessions) continue;
      if (!leastLoaded || agent.activeSessions.length < leastLoaded.activeSessions.length) {
        leastLoaded = agent;
      }
    }
    return leastLoaded;
  }
}
