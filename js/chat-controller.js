/**
 * ./js/chat-controller.js
 * Chat Controller Module - Manages chat history and message handling
 * Coordinates between UI and API service for sending/receiving messages
 */
const ChatController = (function() {
    'use strict';

    // Private state
    let chatHistory = [];
    let totalTokens = 0;
    let settings = { streaming: false, enableCoT: false, showThinking: true };
    let isThinking = false;
    let lastThinkingContent = '';
    let lastAnswerContent = '';
    // Track executed tool calls to prevent infinite loops
    let executedToolCalls = new Set();
    // Flag to track whether we've resumed after a tool call
    let hasResumed = false;
    // Re-add counter for backward compatibility (prevent ReferenceError)
    let toolCallsThisRound = 0;

    // Debug logger for ChatController
    function debugLog(...args) {
        console.log('[ChatController]', ...args);
    }

    // Add helper to robustly extract JSON tool calls (handles fences and nested braces)
    function extractToolCall(text) {
        // 1. Try fenced JSON block: ```json { ... } ```
        const fenceRegex = /```json\s*([\s\S]*?)\s*```/i;
        const fenceMatch = text.match(fenceRegex);
        if (fenceMatch) {
            try {
                const obj = JSON.parse(fenceMatch[1].trim());
                if (obj.tool && obj.arguments) {
                    return obj;
                }
            } catch (err) {
                console.warn('Tool JSON parse error (fenced):', err);
            }
        }
        // 2. Fallback: find a balanced-brace JSON object anywhere in the text
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '{') {
                let depth = 0;
                for (let j = i; j < text.length; j++) {
                    if (text[j] === '{') depth++;
                    else if (text[j] === '}') depth--;
                    if (depth === 0) {
                        const candidate = text.slice(i, j + 1);
                        try {
                            const obj = JSON.parse(candidate);
                            if (obj.tool && obj.arguments) {
                                return obj;
                            }
                        } catch (_) {
                            // not valid JSON or not a tool call
                        }
                        break;
                    }
                }
            }
        }
        // If the text contains tool markers but failed to parse, log a warning for debugging
        if (text.includes('"tool":') && text.includes('"arguments":')) {
            console.warn('[ChatController] extractToolCall: detected possible tool call but could not parse JSON:', text);
        }
        return null;
    }

    const cotPreamble = `**Chain of Thought Instructions:**
1.  **Understand:** Briefly rephrase the core problem or question.
2.  **Deconstruct:** Break the problem down into smaller, logical steps needed to reach the solution.
3.  **Execute & Explain:** Work through each step sequentially. Show your reasoning, calculations, or data analysis for each step clearly.
4.  **Synthesize:** Combine the findings from the previous steps to formulate the final conclusion.
5.  **Final Answer:** State the final answer clearly and concisely, prefixed exactly with "\\nFinal Answer:".

Begin Reasoning Now:
`;

    /**
     * Initializes the chat controller
     * @param {Object} initialSettings - Initial settings for the chat
     */
    function init(initialSettings) {
        // Reset executed tool calls
        executedToolCalls.clear();
        // Reset and seed chatHistory with system tool instructions
        chatHistory = [{
            role: 'system',
            content: `You are an AI assistant with access to three external tools. Use them to gather information when needed.

VERY IMPORTANT:
- When calling a tool, output ONLY a JSON object and NOTHING ELSE, EXACTLY in this format:
  {"tool":"web_search","arguments":{"query":"your query"}}
  {"tool":"read_url","arguments":{"url":"https://example.com","start":0,"length":1122}}
  {"tool":"instant_answer","arguments":{"query":"your query"}}
- Do NOT wrap the JSON in markdown or add any extra text, explanations, or formatting.
- Wait for the tool result before continuing your reasoning or answer.
- If you do not follow these instructions, your output will not be processed.

TOOLS:
1. web_search(query) → Returns an array of search results [{title, url, snippet}, …].
2. read_url(url[, start, length]) → Returns text content from the specified URL slice.
3. instant_answer(query) → Returns a JSON object from DuckDuckGo Instant Answer API.

For questions requiring up-to-date information, choose the appropriate tool and fetch the necessary data. Only after gathering all relevant information should you proceed to answer.

Begin your interaction.`
        }];
        if (initialSettings) {
            settings = { ...settings, ...initialSettings };
        }
        
        // Set up event handlers through UI controller
        UIController.setupEventHandlers(sendMessage, clearChat);
    }

    /**
     * Updates the settings
     * @param {Object} newSettings - The new settings
     */
    function updateSettings(newSettings) {
        settings = { ...settings, ...newSettings };
        debugLog('Chat settings updated:', settings);
    }

    /**
     * Clears the chat history and resets token count
     */
    function clearChat() {
        chatHistory = [];
        totalTokens = 0;
        Utils.updateTokenDisplay(0);
    }

    /**
     * Gets the current settings
     * @returns {Object} - The current settings
     */
    function getSettings() {
        return { ...settings };
    }

    /**
     * Generates Chain of Thought prompting instructions
     * @param {string} message - The user message
     * @returns {string} - The CoT enhanced message
     */
    function enhanceWithCoT(message) {
        return `${message}

Please think step-by-step, prefix each step with "Step X:". As soon as you decide a tool call is needed, stop and output ONLY the JSON object for the call (nothing else), for example:

Step 1: Identify need to search for KLCI constituents.
{"tool":"web_search","arguments":{"query":"FTSE Bursa Malaysia KLCI index constituents"}}

No further text. The system will run that tool and resume. If no tool call is needed, after your steps output:

Answer: [your final, concise answer here]
`;
    }

    /**
     * Processes the AI response to extract thinking and answer parts
     * @param {string} response - The raw AI response
     * @returns {Object} - Object with thinking and answer components
     */
    function processCoTResponse(response) {
        debugLog("processCoTResponse received:", response);
        // Check if response follows the Step-based CoT format
        const thinkingMatch = response.match(/(Step\s*\d+:.*?)(?=Answer:|$)/s);
        const answerMatch = response.match(/Answer:(.*)$/s);
        debugLog("processCoTResponse: thinkingMatch", thinkingMatch, "answerMatch", answerMatch);

        if (thinkingMatch && answerMatch) {
            const thinking = thinkingMatch[1].trim();
            const answer = answerMatch[1].trim();
            lastThinkingContent = thinking;
            lastAnswerContent = answer;

            return {
                thinking: thinking,
                answer: answer,
                hasStructuredResponse: true
            };
        } else if (response.trim().startsWith('Step') && !response.includes('Answer:')) {
            // Partial CoT (no final answer yet)
            const thinking = response.trim();
            lastThinkingContent = thinking;

            return {
                thinking: thinking,
                answer: lastAnswerContent,
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        }

        // Fallback: treat the entire response as answer
        return {
            thinking: '',
            answer: response,
            hasStructuredResponse: false
        };
    }
    
    /**
     * Extract and update partial CoT response during streaming
     * @param {string} fullText - The current streamed text
     * @returns {Object} - The processed response object
     */
    function processPartialCoTResponse(fullText) {
        debugLog("processPartialCoTResponse received:", fullText);
        if (/Step\s*\d+:/.test(fullText) && !/Answer:/.test(fullText)) {
            // Only CoT steps so far
            const thinking = fullText.trim();

            return {
                thinking: thinking,
                answer: '',
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (/Step\s*\d+:/.test(fullText) && /Answer:/.test(fullText)) {
            // Both CoT steps and final answer are present
            const thinkingMatch = fullText.match(/(Step\s*\d+:.*?)(?=Answer:|$)/s);
            const answerMatch = fullText.match(/Answer:(.*)$/s);

            if (thinkingMatch && answerMatch) {
                return {
                    thinking: thinkingMatch[1].trim(),
                    answer: answerMatch[1].trim(),
                    hasStructuredResponse: true,
                    partial: false
                };
            }
        }

        // Default case - treat as normal text
        return {
            thinking: '',
            answer: fullText,
            hasStructuredResponse: false
        };
    }

    /**
     * Formats the response for display based on settings
     * @param {Object} processed - The processed response with thinking and answer
     * @returns {string} - The formatted response for display
     */
    function formatResponseForDisplay(processed) {
        if (!settings.enableCoT || !processed.hasStructuredResponse) {
            return processed.answer;
        }

        // If showThinking is enabled, show both thinking and answer
        if (settings.showThinking) {
            if (processed.partial && processed.stage === 'thinking') {
                return `Thinking: ${processed.thinking}`;
            } else if (processed.partial) {
                return processed.thinking; // Just the partial thinking
            } else {
                return `Thinking: ${processed.thinking}\n\nAnswer: ${processed.answer}`;
            }
        } else {
            // Otherwise just show the answer (or thinking indicator if answer isn't ready)
            return processed.answer || '🤔 Thinking...';
        }
    }

    /**
     * Sends a message to the AI and handles the response
     */
    async function sendMessage() {
        // Reset resume flag for this message cycle
        hasResumed = false;
        const message = UIController.getUserInput();
        if (!message) return;
        
        // Show status and disable inputs while awaiting AI
        UIController.showStatus('Sending message...');
        document.getElementById('message-input').disabled = true;
        document.getElementById('send-button').disabled = true;
        
        // Reset the partial response tracking
        lastThinkingContent = '';
        lastAnswerContent = '';
        
        // Add user message to UI
        UIController.addMessage('user', message);
        UIController.clearUserInput();
        
        // Apply CoT formatting if enabled
        const enhancedMessage = settings.enableCoT ? enhanceWithCoT(message) : message;
        
        // Get the selected model from SettingsController
        const currentSettings = SettingsController.getSettings();
        const selectedModel = currentSettings.selectedModel;
        
        try {
            if (selectedModel.startsWith('gpt')) {
                // For OpenAI, add enhanced message to chat history before sending to include the CoT prompt.
                chatHistory.push({ role: 'user', content: enhancedMessage });
                debugLog("Sent enhanced message to GPT:", enhancedMessage);
                await handleOpenAIMessage(selectedModel, enhancedMessage);
            } else {
                // For Gemini, ensure chat history starts with user message if empty
                if (chatHistory.length === 0) {
                    chatHistory.push({ role: 'user', content: '' });
                }
                await handleGeminiMessage(selectedModel, enhancedMessage);
            }
        } catch (error) {
            console.error('Error sending message:', error);
            UIController.addMessage('ai', 'Error: ' + error.message);
        } finally {
            // Update token usage display
            Utils.updateTokenDisplay(totalTokens);
            // Clear status and re-enable inputs
            UIController.clearStatus();
            document.getElementById('message-input').disabled = false;
            document.getElementById('send-button').disabled = false;
        }
    }

    /**
     * Handles OpenAI message processing
     * @param {string} model - The OpenAI model to use
     * @param {string} message - The user message
     */
    async function handleOpenAIMessage(model, userInput) {
        // Add user message to history and UI
        chatHistory.push({ role: 'user', content: userInput });
        let fullReply = '';
        const systemMsg = chatHistory[0];
        do {
            const recent = chatHistory.slice(-10);
            const messages = [systemMsg, ...recent];
            if (settings.streaming) {
                fullReply = await ApiService.streamOpenAIRequest(model, messages, (chunk, all) => {
                    fullReply = all;
                    UIController.updateMessageContent(UIController.createEmptyAIMessage(), all);
                });
            } else {
                const res = await ApiService.sendOpenAIRequest(model, messages);
                if (res.error) throw new Error(res.error.message);
                totalTokens += res.usage?.total_tokens || 0;
                fullReply = res.choices[0].message.content;
//                UIController.addMessage('ai', fullReply);
            }
            const toolCall = extractToolCall(fullReply);
            if (toolCall && toolCall.tool) {
                // Save the JSON call in history so next iteration sees updated context
                chatHistory.push({ role: 'assistant', content: fullReply });
                await processToolCall(toolCall);
                // Continue loop with no new user input
                userInput = '';
                continue;
            }
            break;
        } while (true);

        // Final processing of fullReply
        const processed = settings.enableCoT ? processCoTResponse(fullReply) : { answer: fullReply };
        const displayText = settings.enableCoT ? formatResponseForDisplay(processed) : fullReply;
        UIController.addMessage('ai', displayText);
        chatHistory.push({ role: 'assistant', content: fullReply });
    }

    /**
     * Handles Gemini message processing
     * @param {string} model - The Gemini model to use
     * @param {string} message - The user message
     */
    async function handleGeminiMessage(model, message) {
        // Add current message to chat history
        chatHistory.push({ role: 'user', content: message });
        
        if (settings.streaming) {
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (settings.enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Always inject system tool-call instructions at start of context
                const systemMsgG = chatHistory[0];
                // Trim context for smaller models
                const recentG = chatHistory.slice(-10);
                const messagesForGemini = [systemMsgG, ...recentG];
                const fullReply = await ApiService.streamGeminiRequest(
                    model,
                    messagesForGemini,
                    (chunk, fullText) => {
                        streamedResponse = fullText;
                        
                        if (settings.enableCoT) {
                            // Process the streamed response for CoT
                            const processed = processPartialCoTResponse(fullText);
                            
                            // Only show "Thinking..." if we're still waiting
                            if (isThinking && fullText.includes('Answer:')) {
                                isThinking = false;
                            }
                            
                            // Format according to current stage and settings
                            const displayText = formatResponseForDisplay(processed);
                            UIController.updateMessageContent(aiMsgElement, displayText);
                        } else {
                            UIController.updateMessageContent(aiMsgElement, fullText);
                        }
                    }
                );
                
                // Intercept JSON tool call in streaming mode
                const toolCall = extractToolCall(fullReply);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                // Process response for CoT if enabled
                if (settings.enableCoT) {
                    const processed = processCoTResponse(fullReply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        debugLog('AI Thinking:', processed.thinking);
                    }
                    
                    // Update UI with appropriate content based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.updateMessageContent(aiMsgElement, displayText);
                    
                    // Add full response to chat history
                    chatHistory.push({ role: 'assistant', content: fullReply });
                } else {
                    // Add to chat history after completed
                    chatHistory.push({ role: 'assistant', content: fullReply });
                }
                
                // Get token usage
                const tokenCount = await ApiService.getTokenUsage(model, chatHistory);
                if (tokenCount) {
                    totalTokens += tokenCount;
                }
            } catch (err) {
                if (err.name === 'AbortError') {
                    UIController.updateMessageContent(aiMsgElement, 'Error: Request timed out. Please try again.');
                    return;
                }
                UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
                throw err;
            } finally {
                isThinking = false;
            }
        } else {
            // Non-streaming approach
            try {
                const systemMsgGNS = chatHistory[0];
                // Trim context
                const recentGNS = chatHistory.slice(-10);
                const messagesForGeminiNS = [systemMsgGNS, ...recentGNS];
                const session = ApiService.createGeminiSession(model);
                const result = await session.sendMessage(message, messagesForGeminiNS);
                
                // Update token usage if available
                if (result.usageMetadata && typeof result.usageMetadata.totalTokenCount === 'number') {
                    totalTokens += result.usageMetadata.totalTokenCount;
                }
                
                // Process response
                const candidate = result.candidates[0];
                let textResponse = '';
                
                if (candidate.content.parts) {
                    textResponse = candidate.content.parts.map(p => p.text).join(' ');
                } else if (candidate.content.text) {
                    textResponse = candidate.content.text;
                }
                
                // Intercept tool call JSON
                const toolCall = extractToolCall(textResponse);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                if (settings.enableCoT) {
                    const processed = processCoTResponse(textResponse);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        debugLog('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    chatHistory.push({ role: 'assistant', content: textResponse });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    chatHistory.push({ role: 'assistant', content: textResponse });
                    UIController.addMessage('ai', textResponse);
                }
            } catch (err) {
                throw err;
            }
        }
    }

    /**
     * Executes a tool call, injects result into chat, and continues reasoning
     */
    async function processToolCall(call) {
        const callKey = JSON.stringify(call);
        const isDuplicate = executedToolCalls.has(callKey);

        try {
            if (isDuplicate) {
                debugLog('Skipping duplicate toolCall:', call);
            } else {
                // Mark as executed
                executedToolCalls.add(callKey);
                let result;

                if (call.tool === 'web_search') {
                    UIController.showStatus(`Searching web for "${call.arguments.query}"...`);
                    try {
                        const items = await ToolsService.webSearch(call.arguments.query);
                        const htmlItems = items.map(r =>
                            `<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title}</a><br><small>${r.url}</small><p>${Utils.escapeHtml(r.snippet)}</p></li>`
                        ).join('');
                        const html = `<div class="tool-result" role="group" aria-label="Search results for ${call.arguments.query}"><strong>Search results for "${call.arguments.query}" (${items.length}):</strong><ul>${htmlItems}</ul></div>`;
                        UIController.addHtmlMessage('ai', html);
                        const plainTextResults = items.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
                        chatHistory.push({ role: 'assistant', content: `Search results for "${call.arguments.query}" (${items.length}):\n${plainTextResults}` });

                        // Attempt read_url for each item; skip if it fails
                        for (const item of items) {
                            try {
                                await processToolCall({ tool: 'read_url', arguments: { url: item.url, start: 0, length: 1122 }, skipContinue: true });
                            } catch (err) {
                                debugLog(`Skipping read_url for ${item.url} due to error:`, err);
                            }
                        }
                    } catch (err) {
                        console.warn('Web search failed:', err);
                        const fallback = `Unable to retrieve search results for "${call.arguments.query}". Proceeding with available knowledge.`;
                        UIController.addMessage('ai', fallback);
                        chatHistory.push({ role: 'assistant', content: fallback });
                    }

                } else if (call.tool === 'read_url') {
                    UIController.showStatus(`Reading content from ${call.arguments.url}...`);
                    let pageText;
                    try {
                        pageText = await ToolsService.readUrl(call.arguments.url);
                    } catch (err) {
                        debugLog(`read_url failed for ${call.arguments.url}, skipping this URL:`, err);
                        UIController.addMessage('ai', `[read_url] Skipped content from ${call.arguments.url} due to an error.`);
                        pageText = null;
                    }
                    if (pageText) {
                        const fullText = String(pageText);
                        const totalLength = fullText.length;
                        const chunkSize = (typeof call.arguments.length === 'number' && call.arguments.length > 0) ? call.arguments.length : 1122;
                        for (let offset = (typeof call.arguments.start === 'number' && call.arguments.start >= 0 ? call.arguments.start : 0); offset < totalLength; offset += chunkSize) {
                            const snippet = fullText.slice(offset, offset + chunkSize);
                            const hasMore = offset + chunkSize < totalLength;
                            const html = `<div class="tool-result" role="group" aria-label="Read content from ${call.arguments.url}"><strong>Read from:</strong> <a href="${call.arguments.url}" target="_blank" rel="noopener noreferrer">${call.arguments.url}</a><p>${Utils.escapeHtml(snippet)}${hasMore ? '...' : ''}</p></div>`;
                            UIController.addHtmlMessage('ai', html);
                            chatHistory.push({ role: 'assistant', content: `Read content from ${call.arguments.url}:\n${snippet}${hasMore ? '...' : ''}` });
                            debugLog(`[read_url] url=${call.arguments.url}, offset=${offset}, snippetLength=${snippet.length}, hasMore=${hasMore}`);
                            // If no more content, break
                            if (!hasMore) break;
                            // Ask AI decision
                            const decisionPrompt =
                                `SNIPPET ONLY:\n${snippet}\n\nIf you need more text from this URL, reply ONLY with YES. If no more text is needed, reply ONLY with NO. NOTHING ELSE.`;
                            let shouldFetchMore = false;
                            try {
                                const selectedModel = SettingsController.getSettings().selectedModel;
                                if (selectedModel.startsWith('gpt')) {
                                    const decisionRes = await ApiService.sendOpenAIRequest(selectedModel, [
                                        { role: 'system', content: 'You decide whether additional URL content is needed.' },
                                        { role: 'user', content: decisionPrompt }
                                    ]);
                                    shouldFetchMore = decisionRes.choices[0].message.content.trim().toLowerCase().startsWith('yes');
                                } else {
                                    const session = ApiService.createGeminiSession(selectedModel);
                                    const decisionResult = await session.sendMessage('', [{ role: 'user', content: decisionPrompt }]);
                                    const candidate = decisionResult.candidates && decisionResult.candidates[0];
                                    const decisionText = candidate?.content?.parts ? candidate.content.parts.map(p => p.text).join('') : candidate.content?.text || '';
                                    shouldFetchMore = decisionText.trim().toLowerCase().startsWith('yes');
                                }
                            } catch (err) {
                                debugLog('Decision fetch error:', err);
                            }
                            if (!shouldFetchMore) break;
                        }
                    }

                } else if (call.tool === 'instant_answer') {
                    UIController.showStatus(`Retrieving instant answer for "${call.arguments.query}"...`);
                    try {
                        const ia = await ToolsService.instantAnswer(call.arguments.query);
                        const text = JSON.stringify(ia, null, 2);
                        UIController.addMessage('ai', text);
                        chatHistory.push({ role: 'assistant', content: text });
                    } catch (err) {
                        debugLog('instantAnswer failed:', err);
                        UIController.addMessage('ai', `[instant_answer] Error retrieving instant answer.`);
                    }

                } else {
                    throw new Error(`Unknown tool: ${call.tool}`);
                }
            }
        } catch (err) {
            debugLog('Error during tool execution:', err);
        } finally {
            UIController.clearStatus();
            // Only resume once after the first non-duplicate tool call
            if (!call.skipContinue && !isDuplicate && !hasResumed) {
                hasResumed = true;
                try {
                    const selectedModel = SettingsController.getSettings().selectedModel;
                    if (selectedModel.startsWith('gpt')) {
                        debugLog('Continuing conversation with GPT');
                        // Resume GPT with existing context (tool results in chatHistory)
                        await handleOpenAIMessage(selectedModel, '');
                    } else {
                        // For Gemini, push next user prompt for continuation
                        const lastUserMsg = chatHistory.filter(m => m.role === 'user').pop()?.content || '';
                        const nextMsg = settings.enableCoT ? enhanceWithCoT(lastUserMsg) : lastUserMsg;
                        chatHistory.push({ role: 'user', content: nextMsg });
                        debugLog('Continuing conversation with Gemini:', nextMsg);
                        await handleGeminiMessage(selectedModel, nextMsg);
                    }
                } catch (err) {
                    debugLog('Continuation error:', err);
                }
            }
        }
    }

    /**
     * Gets the current chat history
     * @returns {Array} - The chat history
     */
    function getChatHistory() {
        return [...chatHistory];
    }

    /**
     * Gets the total tokens used
     * @returns {number} - The total tokens used
     */
    function getTotalTokens() {
        return totalTokens;
    }

    // Add a function to execute tool calls without recursion
    async function executeToolCall(call) {
        const callKey = JSON.stringify(call);
        if (executedToolCalls.has(callKey)) {
            debugLog('Skipping duplicate toolCall:', call);
            UIController.clearStatus();
            return;
        }
        executedToolCalls.add(callKey);
        UIController.showStatus(`Executing tool: ${call.tool}`);
        try {
            if (call.tool === 'web_search') {
                const items = await ToolsService.webSearch(call.arguments.query);
                const htmlItems = items.map(r =>
                    `<li><a href="${r.url}" target="_blank" rel="noopener">${r.title}</a><br><small>${r.url}</small><p>${Utils.escapeHtml(r.snippet)}</p></li>`
                ).join('');
                UIController.addHtmlMessage('ai', `<ul>${htmlItems}</ul>`);
                const plainText = items.map((r,i)=>`${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
                chatHistory.push({role:'assistant', content: plainText });
                // optionally initiate read_url calls here
            } else if (call.tool === 'read_url') {
                const text = await ToolsService.readUrl(call.arguments.url);
                const snippet = String(text).slice(call.arguments.start || 0, (call.arguments.start||0) + (call.arguments.length||1000));
                UIController.addHtmlMessage('ai', `<p>${Utils.escapeHtml(snippet)}</p>`);
                chatHistory.push({ role:'assistant', content: snippet });
            } else if (call.tool === 'instant_answer') {
                const ia = await ToolsService.instantAnswer(call.arguments.query);
                const jsonText = JSON.stringify(ia, null, 2);
                UIController.addMessage('ai', jsonText);
                chatHistory.push({ role:'assistant', content: jsonText });
            } else {
                UIController.addMessage('ai', `Unknown tool: ${call.tool}`);
            }
        } catch (err) {
            debugLog('Error during tool execution:', err);
            UIController.addMessage('ai', `Error executing tool ${call.tool}: ${err.message}`);
        } finally {
            UIController.clearStatus();
        }
    }

    // Public API
    return {
        init,
        updateSettings,
        getSettings,
        sendMessage,
        getChatHistory,
        getTotalTokens,
        clearChat
    };
})(); 