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

    // Add helper to robustly extract JSON tool calls (handles markdown fences)
    function extractToolCall(text) {
        // Extract all JSON-like blocks and parse for tool calls
        const jsonMatches = text.match(/\{[\s\S]*?\}/g);
        if (!jsonMatches) return null;
        for (let match of jsonMatches) {
            try {
                // Remove markdown fences and normalize quotes
                let jsonStr = match.replace(/```json|```/g, '').trim();
                jsonStr = jsonStr.replace(/'/g, '"');
                const obj = JSON.parse(jsonStr);
                if (obj.tool && obj.arguments) {
                    return obj;
                }
            } catch (err) {
                // Ignore parse errors and try next
            }
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
        console.log('Chat settings updated:', settings);
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
        return `${message}\n\nI'd like you to use Chain of Thought reasoning. Please think step-by-step before providing your final answer. Format your response like this:
Thinking: [detailed reasoning process, exploring different angles and considerations]
Answer: [your final, concise answer based on the reasoning above]`;
    }

    /**
     * Processes the AI response to extract thinking and answer parts
     * @param {string} response - The raw AI response
     * @returns {Object} - Object with thinking and answer components
     */
    function processCoTResponse(response) {
        console.log("processCoTResponse received:", response);
        // Check if response follows the Thinking/Answer format
        const thinkingMatch = response.match(/Thinking:(.*?)(?=Answer:|$)/s);
        const answerMatch = response.match(/Answer:(.*?)$/s);
        console.log("processCoTResponse: thinkingMatch", thinkingMatch, "answerMatch", answerMatch);
        
        if (thinkingMatch && answerMatch) {
            const thinking = thinkingMatch[1].trim();
            const answer = answerMatch[1].trim();
            
            // Update the last known content
            lastThinkingContent = thinking;
            lastAnswerContent = answer;
            
            return {
                thinking: thinking,
                answer: answer,
                hasStructuredResponse: true
            };
        } else if (response.startsWith('Thinking:') && !response.includes('Answer:')) {
            // Partial thinking (no answer yet)
            const thinking = response.replace(/^Thinking:/, '').trim();
            lastThinkingContent = thinking;
            
            return {
                thinking: thinking,
                answer: lastAnswerContent,
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (response.includes('Thinking:') && !thinkingMatch) {
            // Malformed response (partial reasoning)
            const thinking = response.replace(/^.*?Thinking:/s, 'Thinking:');
            
            return {
                thinking: thinking.replace(/^Thinking:/, '').trim(),
                answer: '',
                hasStructuredResponse: false,
                partial: true
            };
        }
        
        // If not properly formatted, return the whole response as the answer
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
        console.log("processPartialCoTResponse received:", fullText);
        if (fullText.includes('Thinking:') && !fullText.includes('Answer:')) {
            // Only thinking so far
            const thinking = fullText.replace(/^.*?Thinking:/s, '').trim();
            
            return {
                thinking: thinking,
                answer: '',
                hasStructuredResponse: true,
                partial: true,
                stage: 'thinking'
            };
        } else if (fullText.includes('Thinking:') && fullText.includes('Answer:')) {
            // Both thinking and answer are present
            const thinkingMatch = fullText.match(/Thinking:(.*?)(?=Answer:|$)/s);
            const answerMatch = fullText.match(/Answer:(.*?)$/s);
            
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
                console.log("Sent enhanced message to GPT:", enhancedMessage);
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
    async function handleOpenAIMessage(model, message) {
        if (settings.streaming) {
            // Show status for streaming response
            UIController.showStatus('Streaming response...');
            // Streaming approach
            const aiMsgElement = UIController.createEmptyAIMessage();
            let streamedResponse = '';
            
            try {
                // Start thinking indicator if CoT is enabled
                if (settings.enableCoT) {
                    isThinking = true;
                    UIController.updateMessageContent(aiMsgElement, '🤔 Thinking...');
                }
                
                // Process streaming response
                const fullReply = await ApiService.streamOpenAIRequest(
                    model, 
                    chatHistory,
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
                        console.log('AI Thinking:', processed.thinking);
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
                UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
                throw err;
            } finally {
                isThinking = false;
            }
        } else {
            // Show status for non-streaming response
            UIController.showStatus('Waiting for AI response...');
            // Non-streaming approach
            try {
                const result = await ApiService.sendOpenAIRequest(model, chatHistory);
                
                if (result.error) {
                    throw new Error(result.error.message);
                }
                
                // Update token usage
                if (result.usage && result.usage.total_tokens) {
                    totalTokens += result.usage.total_tokens;
                }
                
                // Process response
                const reply = result.choices[0].message.content;
                console.log("GPT non-streaming reply:", reply);

                // Intercept tool call JSON
                const toolCall = extractToolCall(reply);
                if (toolCall && toolCall.tool && toolCall.arguments) {
                    await processToolCall(toolCall);
                    return;
                }
                
                if (settings.enableCoT) {
                    const processed = processCoTResponse(reply);
                    
                    // Add thinking to debug console if available
                    if (processed.thinking) {
                        console.log('AI Thinking:', processed.thinking);
                    }
                    
                    // Add the full response to chat history
                    chatHistory.push({ role: 'assistant', content: reply });
                    
                    // Show appropriate content in the UI based on settings
                    const displayText = formatResponseForDisplay(processed);
                    UIController.addMessage('ai', displayText);
                } else {
                    chatHistory.push({ role: 'assistant', content: reply });
                    UIController.addMessage('ai', reply);
                }
            } catch (err) {
                throw err;
            }
        }
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
                
                // Process streaming response
                const fullReply = await ApiService.streamGeminiRequest(
                    model,
                    chatHistory,
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
                        console.log('AI Thinking:', processed.thinking);
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
                UIController.updateMessageContent(aiMsgElement, 'Error: ' + err.message);
                throw err;
            } finally {
                isThinking = false;
            }
        } else {
            // Non-streaming approach
            try {
                const session = ApiService.createGeminiSession(model);
                const result = await session.sendMessage(message, chatHistory);
                
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
                        console.log('AI Thinking:', processed.thinking);
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
        const { tool, arguments: args, skipContinue } = call;
        let result;
        // Show status while calling tool
        if (tool === 'web_search') {
            UIController.showStatus(`Searching web for "${args.query}"...`);
            try {
                result = await ToolsService.webSearch(args.query);
                // Format search results
                const items = result || [];
                const htmlItems = items.map(r =>
                    `<li><a href="${r.url}" target="_blank" rel="noopener noreferrer">${r.title}</a><br><small>${r.url}</small><p>${Utils.escapeHtml(r.snippet)}</p></li>`
                ).join('');
                const html = `<div class="tool-result" role="group" aria-label="Search results for ${args.query}"><strong>Search results for “${args.query}” (${items.length}):</strong><ul>${htmlItems}</ul></div>`;
                UIController.addHtmlMessage('ai', html);
                // Add plain text results to chat history for model processing
                const plainTextResults = items.map((r, i) => `${i+1}. ${r.title} (${r.url}) - ${r.snippet}`).join('\n');
                chatHistory.push({ role: 'assistant', content: `Search results for "${args.query}" (${items.length}):\n${plainTextResults}` });

                // Automatically trigger read_url logic without restarting COT
                for (const item of items) {
                    // Trigger read_url logic without restarting COT
                    await processToolCall({ tool: 'read_url', arguments: { url: item.url, start: 0, length: 1122 }, skipContinue: true });
                }
            } catch (err) {
                console.warn(`Web search failed:`, err);
                UIController.clearStatus();
                const fallback = `Unable to retrieve search results for "${args.query}". Proceeding with available knowledge.`;
                UIController.addMessage('ai', fallback);
                chatHistory.push({ role: 'assistant', content: fallback });
                // Continue reasoning with current info
                const selectedModel = SettingsController.getSettings().selectedModel;
                if (selectedModel.startsWith('gpt')) {
                    await handleOpenAIMessage(selectedModel, '');
                } else {
                    await handleGeminiMessage(selectedModel, '');
                }
                return;
            }
        } else if (tool === 'read_url') {
            UIController.showStatus(`Reading content from ${args.url}...`);
            // Fetch full page text
            result = await ToolsService.readUrl(args.url);
            // Determine slicing parameters
            const start = (typeof args.start === 'number' && args.start >= 0) ? args.start : 0;
            const length = (typeof args.length === 'number' && args.length > 0) ? args.length : 1122;
            const snippet = String(result).slice(start, start + length);
            const hasMore = (start + length) < String(result).length;
            const html = `<div class="tool-result" role="group" aria-label="Read content from ${args.url}"><strong>Read from:</strong> <a href="${args.url}" target="_blank" rel="noopener noreferrer">${args.url}</a><p>${Utils.escapeHtml(snippet)}${hasMore ? '...' : ''}</p></div>`;
            UIController.addHtmlMessage('ai', html);
            // Add plain text snippet to chat history for model processing
            const plainTextSnippet = `Read content from ${args.url}:\n${snippet}${hasMore ? '...' : ''}`;
            chatHistory.push({ role: 'assistant', content: plainTextSnippet });
            // Debug logs for read_url logic
            console.log(`[read_url] url=${args.url}, fullLength=${String(result).length}, snippetLength=${snippet.length}, hasMore=${hasMore}`);

            // Auto-decision: ask AI if we should fetch more
            if (hasMore) {
                console.log(`[read_url] Prompting AI for decision to fetch more (start=${start}, length=${length})`);
                // Retrieve last user query
                const lastUser = chatHistory.filter(m => m.role === 'user').pop().content;
                const decisionPrompt = `User query: "${lastUser}"\nSnippet: "${snippet}"\n\nShould you fetch more content from this URL? Reply YES or NO.`;
                let shouldFetchMore = false;
                try {
                    const selectedModel = SettingsController.getSettings().selectedModel;
                    if (selectedModel.startsWith('gpt')) {
                        const decisionRes = await ApiService.sendOpenAIRequest(selectedModel, [
                            { role: 'system', content: 'You decide whether additional URL content is needed.' },
                            { role: 'user', content: decisionPrompt }
                        ]);
                        const decisionText = decisionRes.choices[0].message.content.trim().toLowerCase();
                        console.log(`[read_url] AI decision response: "${decisionText}"`);
                        shouldFetchMore = decisionText.startsWith('yes');
                    }
                } catch (err) {
                    console.error('Decision fetch error:', err);
                }
                if (shouldFetchMore) {
                    console.log(`[read_url] Fetching extended content slice from ${start + length} to ${start + length + 5000}`);
                    UIController.showStatus(`Fetching extended content from ${args.url}...`);
                    const extended = String(result).slice(start + length, start + length + 5000);
                    UIController.clearStatus();
                    const extHasMore = (start + length + 5000) < String(result).length;
                    const extHtml = `<div class=\"tool-result\" role=\"group\" aria-label=\"Extended content from ${args.url}\"><strong>Extended from:</strong> <a href=\"${args.url}\" target=\"_blank\" rel=\"noopener noreferrer\">${args.url}</a><p>${Utils.escapeHtml(extended)}${extHasMore ? '...' : ''}</p></div>`;
                    UIController.addHtmlMessage('ai', extHtml);
                    const extTextSnippet = `Extended content from ${args.url}:\n${extended}${extHasMore ? '...' : ''}`;
                    chatHistory.push({ role: 'assistant', content: extTextSnippet });
                }
            }
        } else if (tool === 'instant_answer') {
            UIController.showStatus(`Retrieving instant answer for "${args.query}"...`);
            result = await ToolsService.instantAnswer(args.query);
            const text = JSON.stringify(result, null, 2);
            UIController.addMessage('ai', text);
            chatHistory.push({ role: 'assistant', content: text });
        } else {
            throw new Error(`Unknown tool: ${tool}`);
        }
        // Clear status
        UIController.clearStatus();
        // Continue Chain-of-Thought with updated history for the active model, unless skipped
        if (!skipContinue) {
            const selectedModel = SettingsController.getSettings().selectedModel;
            if (selectedModel.startsWith('gpt')) {
                await handleOpenAIMessage(selectedModel, '');
            } else {
                await handleGeminiMessage(selectedModel, '');
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