import { Editor } from '@tldraw/tldraw'
import OpenAI from 'openai'
import { AssistantUpdateParams } from 'openai/resources/beta/assistants/assistants.mjs'
import { Assistant, Thread } from '../../Assistant'
import { fetchText } from '../../lib/fetchText'
import { assert, delayMs } from '../../lib/utils'
import functionCallingPrompt from './function-calling-prompt.md'
import {
	getCurrentPageDescription,
	getCurrentPointer,
	getCurrentViewportDescription,
	placeText,
	pointerDown,
	pointerMove,
	pointerUp,
	selectTool,
} from './functions'
import { getUserMessage } from './getUserMessage'

const apiKey = process.env.OPENAI_API_KEY ?? null
const assistantId = process.env.OPENAI_FUNCTIONS_ASSISTANT_ID ?? null

if (!apiKey) {
	throw Error(
		`Error: OpenAI API key not found, please create an API Key in the OpenAI platform and add it as .env.VITE_OPENAI_API_KEY`
	)
}

if (!assistantId) {
	throw Error(
		`Error: Assistant ID not found, please create an assistant in the OpenAI platform playground and add its id to .env.VITE_OPENAI_ASSISTANT_ID`
	)
}

const openai = new OpenAI({
	apiKey: process.env.OPENAI_API_KEY!,
	dangerouslyAllowBrowser: true,
})

const tools: AssistantUpdateParams['tools'] = [
	{
		type: 'function',
		function: {
			name: 'getCurrentViewport',
			description: "Get the current viewport's page coordinates.",
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'getCurrentPage',
			description: 'Get the current page description.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'getCurrentPointer',
			description: 'Get the current pointer coordinates on the page.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	// {
	// 	type: 'function',
	// 	function: {
	// 		name: 'startShape',
	// 		description:
	// 			'Start drawing a new shape. The shape provided will help identify what you created later.',
	// 		parameters: {
	// 			type: 'object',
	// 			properties: {
	// 				name: {
	// 					type: 'string',
	// 				},
	// 			},
	// 		},
	// 	},
	// },
	// {
	// 	type: 'function',
	// 	function: {
	// 		name: 'endShape',
	// 		description: 'Stop drawing the current shape.',
	// 		parameters: {
	// 			type: 'object',
	// 			properties: {},
	// 		},
	// 	},
	// },
	{
		type: 'function',
		function: {
			name: 'pointerMove',
			description: 'Move the cursor the provided coordinates on the page.',
			parameters: {
				type: 'object',
				properties: {
					x: {
						type: 'number',
						description: 'The x coordinate',
					},
					y: {
						type: 'number',
						description: 'The y coordinate',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'pointerDown',
			description: "Start pointing at the cursor's current coordinates.",
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'pointerUp',
			description: "Stop pointing at the cursor's current coordinates.",
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'placeText',
			description: 'Place a text label centered on the provided coordinates.',
			parameters: {
				type: 'object',
				properties: {
					text: {
						type: 'string',
						description: 'The text to place',
					},
					x: {
						type: 'number',
						description: 'The x coordinate',
					},
					y: {
						type: 'number',
						description: 'The y coordinate',
					},
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'selectTool',
			description: 'Select a new tool.',
			parameters: {
				type: 'object',
				properties: {
					tool: {
						type: 'string',
						enum: ['select', 'draw', 'box', 'ellipse', 'arrow'],
					},
				},
			},
		},
	},
]

export class OpenAiWithFunctionCallingAssistant implements Assistant<undefined> {
	constructor() {}

	assistantPromise: Promise<OpenAI.Beta.Assistants.Assistant> | null = null
	getAssistant() {
		if (!this.assistantPromise) {
			this.assistantPromise = (async () => {
				const prompt = await fetchText(functionCallingPrompt)

				return await openai.beta.assistants.update(assistantId!, {
					instructions: prompt,
					model: 'gpt-4-32k-0613',
					tools,
				})
			})()
		}
		return this.assistantPromise
	}

	async createThread(editor: Editor) {
		const assistant = await this.getAssistant()
		const thread = await openai.beta.threads.create()
		return new OpenAiWithFunctionCallingThread(assistant, thread, editor)
	}
}

export class OpenAiWithFunctionCallingThread implements Thread<undefined> {
	constructor(
		readonly assistant: OpenAI.Beta.Assistants.Assistant,
		readonly thread: OpenAI.Beta.Threads.Thread,
		readonly editor: Editor
	) {}

	current: { run: OpenAI.Beta.Threads.Run | null } | null = null

	getUserMessage(input: string) {
		return getUserMessage(this.editor, input)
	}

	async sendMessage(userMessage: string) {
		if (this.current) {
			throw new Error('Cannot send message while another message is being sent.')
		}
		this.current = { run: null }

		await openai.beta.threads.messages.create(this.thread.id, {
			role: 'user',
			content: userMessage,
		})

		const run = await openai.beta.threads.runs.create(this.thread.id, {
			assistant_id: this.assistant.id,
		})
		const runId = run.id
		this.current.run = run

		// eslint-disable-next-line no-constant-condition
		while (true) {
			await delayMs(500)
			const currentRun = await openai.beta.threads.runs.retrieve(this.thread.id, runId)

			switch (currentRun.status) {
				case 'in_progress':
				case 'queued':
					continue
				case 'requires_action': {
					const toolCalls = currentRun.required_action?.submit_tool_outputs?.tool_calls
					assert(toolCalls)

					const toolOutputs: OpenAI.Beta.Threads.Runs.RunSubmitToolOutputsParams['tool_outputs'] =
						[]

					for (const call of toolCalls) {
						const {
							id,
							function: { name },
						} = call

						console.log(`calling ${name} with arguments: ${call.function.arguments}`)

						switch (name) {
							case 'getCurrentViewport': {
								const page = getCurrentViewportDescription(this.editor)
								toolOutputs.push({
									tool_call_id: id,
									output: JSON.stringify(page.toJson()),
								})
								break
							}
							case 'getCurrentPage': {
								const page = getCurrentPageDescription(this.editor)
								toolOutputs.push({
									tool_call_id: id,
									output: page,
								})
								break
							}
							case 'getCurrentPointer': {
								const { x, y } = getCurrentPointer(this.editor)
								toolOutputs.push({
									tool_call_id: id,
									output: JSON.stringify({ x, y }),
								})
								break
							}
							case 'pointerMove': {
								await pointerMove(this.editor, JSON.parse(call.function.arguments))
								toolOutputs.push({
									tool_call_id: id,
									output: 'success',
								})
								break
							}
							case 'pointerDown': {
								await pointerDown(this.editor)
								toolOutputs.push({
									tool_call_id: id,
									output: 'success',
								})
								break
							}
							case 'pointerUp': {
								await pointerUp(this.editor)
								toolOutputs.push({
									tool_call_id: id,
									output: 'success',
								})
								break
							}
							case 'selectTool': {
								selectTool(this.editor, JSON.parse(call.function.arguments))
								toolOutputs.push({
									tool_call_id: id,
									output: 'success',
								})
								break
							}
							case 'placeText': {
								placeText(this.editor, JSON.parse(call.function.arguments))
								toolOutputs.push({
									tool_call_id: id,
									output: 'success',
								})
								break
							}
							case 'startShape': {
								toolOutputs.push({
									tool_call_id: id,
									output: 'ok',
								})
								break
							}
							case 'endShape': {
								toolOutputs.push({
									tool_call_id: id,
									output: 'ok',
								})
								break
							}
							default: {
								throw new Error(`Unknown tool call: ${name}`)
							}
						}
					}

					await openai.beta.threads.runs.submitToolOutputs(this.thread.id, currentRun.id, {
						tool_outputs: toolOutputs,
					})

					break
				}
				case 'completed': {
					const messages = await openai.beta.threads.messages.list(this.thread.id)
					const mostRecent = messages.data[0]
					const results = []
					for (const content of mostRecent.content) {
						if (content.type === 'text') {
							results.push(content.text.value)
						}
					}

					console.log(results.join('\n\n'))

					this.current = null
					return undefined
				}
				default:
					this.current = null
					throw Error(`Error: run failed with status ${currentRun.status}`)
			}
		}
	}

	async cancel() {
		if (this.current?.run) {
			await openai.beta.threads.runs.cancel(this.thread.id, this.current.run.id)
		}
		this.current = null
	}

	async handleAssistantResponse(): Promise<void> {}
}
