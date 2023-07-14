import { BaseUserMeta, Client, createClient } from '@liveblocks/client';
import { authorize } from './authorize';

export interface Env {
	LiveWorker: DurableObjectNamespace;
	LIVEBLOCKS_SECRET: string;
	OPEN_AI_ACCESS_KEY: string;
}

export type ChatMessage = {
	text: string;
	username: string;
};

type BroadcastEvent = {
	type: 'message';
	data: ChatMessage;
};

export type Presence = {
	isTyping: boolean;
};

type Storage = {};
export type UserMeta = { username?: string; isBot?: boolean } & BaseUserMeta;

//this is the tiemeout for leaving after inactivity in room,
const DISCONNECTION_TIMEOUT = 10000; //10 seconds

export class LiveWorker {
	state: DurableObjectState;
	env: Env;
	liveblocksClient?: Client;
	inactiveTimeout?: ReturnType<typeof setTimeout>;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async askGpt(messages: { role: 'user' | 'assistant'; content: string }[]): Promise<any> {
		const res = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.env.OPEN_AI_ACCESS_KEY}`,
			},

			//ideally we shall give a message list, for more interactive experience, but it's costly & i only have 5$ credit 😅
			body: JSON.stringify({
				model: 'gpt-3.5-turbo',
				messages,
			}),
		});

		return res.json();
	}

	initializeLiveblocks(roomId: string): void {
		if (this.liveblocksClient) {
			if (this.liveblocksClient.getRoom(roomId)?.getStatus() !== 'disconnected') return;

			this.liveblocksClient = undefined;

			return this.initializeLiveblocks(roomId);
		}

		this.liveblocksClient = createClient({
			authEndpoint: async (roomId) => {
				const res = await authorize({
					room: roomId,
					secret: this.env.LIVEBLOCKS_SECRET,
					userId: `wokrer${roomId}`,
					userInfo: {
						bot: true,
						username: 'bot',
					},
				});
				return JSON.parse(res.body) as any;
			},
		});

		const room = this.liveblocksClient.enter<Presence, Storage, UserMeta, BroadcastEvent>(roomId, {
			initialPresence: { isTyping: false },
			shouldInitiallyConnect: true,
		});

		room.subscribe('others', (others) => {
			if (others.length < 1) {
				if (this.inactiveTimeout) return;
				this.inactiveTimeout = setTimeout(() => {
					console.log(`leaving due to inaxtiviy`);
					this.liveblocksClient!.leave(roomId);
				}, DISCONNECTION_TIMEOUT);
			} else {
				if (this.inactiveTimeout) {
					console.log(`clearing inactivity`);
					clearInterval(this.inactiveTimeout);
					this.inactiveTimeout = undefined;
				}
			}
		});

		room.subscribe('event', async ({ event }) => {
			if (event.type === 'message') {
				const others = room.getOthers();

				if (event.data.text.startsWith('/bot ')) {
					try {
						room.updatePresence({ isTyping: true });
						// const completion = await this.openAi.createChatCompletion({
						// 	model: 'gpt-3.5-turbo',
						// 	messages: [{ role: 'user', content: event.data.text.split('/bot ')[1] || '' }],
						// });

						const completion = await this.askGpt([{ role: 'user', content: event.data.text.split('/bot ')[1] || '' }]);

						room.broadcastEvent({
							type: 'message',
							data: { text: completion.choices[0].message?.content || 'Hey this is bot here.', username: 'bot' },
						});
					} catch (error) {
						console.log(error);
					} finally {
						console.log(`updating presence to false`);
						room.updatePresence({ isTyping: false });
						return;
					}
				}

				//this means only the bot and the user is present, to make the chat more interactive, ot will always reply if there is only one other user in the room
				if (others.length < 2) {
					try {
						room.updatePresence({ isTyping: true });
						const completion = await this.askGpt([
							{
								role: 'user',
								content: `You're an exclusive chat bot for this room, you only reply to commands that start with "/bot " and if there is only one suer in the room. right now there is only one user in the room, reply to their message, you should also mention to the user that they're the only ones, in fun ways. `,
							},
							{ role: 'user', content: event.data.text || '' },
						]);

						room.broadcastEvent({
							type: 'message',
							data: { text: completion.choices[0].message?.content || 'Hey this is bot here.', username: 'bot' },
						});
					} catch (error) {
					} finally {
						console.log(`updating presence to false`);
						room.updatePresence({ isTyping: false });
					}
				}
			}
		});

		room.subscribe('lost-connection', (event) => {
			switch (event) {
				case 'lost':
					console.warn('Still trying to reconnect...');
					break;

				case 'restored':
					console.log('Successfully reconnected again!');
					break;

				case 'failed':
					console.error('Could not restore the connection');
					this.initializeLiveblocks(roomId);
					break;
			}
		});

		room.subscribe('status', (status) => {
			console.log(status);
			if (status === 'connected') {
				room.broadcastEvent({ type: 'message', data: { text: "I've just joined", username: 'bot' } });
			}
		});
	}

	async fetch(req: Request) {
		let { searchParams } = new URL(req.url);
		const roomId = searchParams.get('roomId');

		try {
			this.initializeLiveblocks(roomId!);
		} catch (error) {}
		return new Response('Ok', { headers: { 'Access-Control-Allow-Origin': '*' } });
	}
}

async function handleApiRequest(request: Request, env: Env) {
	let { searchParams } = new URL(request.url);

	const roomId = searchParams.get('roomId');
	const userId = searchParams.get('userId');

	if (!roomId) {
		return new Response('Not Found', { status: 404 });
	}

	if (userId) {
		const res = await authorize({
			room: roomId!,
			secret: env.LIVEBLOCKS_SECRET,
			userId: userId,
			userInfo: {
				username: searchParams.get('username') || 'anonymous',
			},
		});

		return new Response(res.body, { headers: { 'Access-Control-Allow-Origin': '*' } });
	}
	return env.LiveWorker.get(env.LiveWorker.idFromName(roomId)).fetch(request.url, request);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return await handleApiRequest(request, env);
	},
};
