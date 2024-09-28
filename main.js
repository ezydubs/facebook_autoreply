const fs = require("fs");
const login = require("@xaviabot/fca-unofficial");
const OpenAI = require("openai");
const { format } = require("date-fns"); // We'll use date-fns to format dates
const tiktoken = require("tiktoken"); // Import tiktoken
const { resolve } = require("path");

// Set up OpenAI API
const openai = new OpenAI({
    apiKey: 'sk-Z1y-',
});

var sys = `
DO NOT ASK MORE THAN A SINGLE QUESTION IN THE RESPONSE. Make the response as short as possible, dont keep saying the contact number back. You are a friendly and professional Facebook reply bot for listing inquiries. All the details of the listing will be in the listing description such as the year, make, model, description etc.. so tell the user to check the listing details. finance is avalible on the website as well, Aferpay, genoapay etc.. and everything else. Greet the user, encourage engagement by asking if they have specific questions or want to schedule a viewing, ask politely for their contact details (phone number and email) for easier communication, offer more info if requested, maintain a helpful tone, and avoid pressuring the user. The location is auckland CBD. the phone number is 0211111111.
`

const systemPrompt = {
    role: "system",
    content: sys,
    temperature: 0.2
};

const chatHistories = {};
const maxTokens = 8192; // Maximum token limit for GPT-4 model
var blacklist = [];

function detectContactDetails(message) {
    // Email regex pattern
    const emailPattern = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/;
    
    // Phone number regex pattern (adjust as needed)
    const phonePattern = /\b(?:\+?(\d{1,3}))?[-.\s]?(\d{1,4})[-.\s]?(\d{1,4})[-.\s]?(\d{1,9})\b/;
    
    // Test for email and phone in the message
    const foundEmail = emailPattern.test(message);
    const foundPhone = phonePattern.test(message);
    
    return { foundEmail, foundPhone };
}

function countTokens(messages) {
    const encoder = tiktoken.encoding_for_model("gpt-4"); // Get the encoder for GPT-4
    let totalTokens = 0;

    // Calculate the number of tokens for each message
    for (const message of messages) {
        const messageTokens = encoder.encode(`${message.role}: ${message.content}`);
        totalTokens += messageTokens.length;
    }

    return totalTokens;
}

function trimHistory(threadID) {
    const history = chatHistories[threadID];

    // Keep removing the oldest messages until we are under the token limit
    while (countTokens(history) > maxTokens) {
        history.splice(1, 1); // Remove the second message (keep the system message)
    }
}

async function detectInquiryType(newMessage) {
    try {
        // Send a request to GPT to classify the message as "simple" or "complex"
        const classificationResponse = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [
                {
                    role: "system",
                    content: "You are a classifier. Classify the following message as 'simple' if it is a basic inquiry like 'Is this available?' or 'Hi'. Classify it as 'complex' if it requires a more detailed response."
                },
                {
                    role: "user",
                    content: newMessage
                }
            ],
            max_tokens: 10 // Keep this response short, we only need "simple" or "complex"
        });

        const inquiryType = classificationResponse.choices[0].message.content.trim().toLowerCase();
        return inquiryType; // Should be either "simple" or "complex"
    } catch (error) {
        console.error("Error classifying the inquiry:", error);
        return "complex"; // Default to complex if there's an error
    }
}

// Function to get AI response from OpenAI
async function getAIResponse(threadID, newMessage,inquiryType) {
    try {
        // Ensure chat history exists for this thread
        if (!chatHistories[threadID]) {
            chatHistories[threadID] = [systemPrompt];
        }
        
        // Append the user's new message to the history
        chatHistories[threadID].push({ role: "user", content: newMessage });
        

        let responseLimit = 300;  // Default token limit for complex responses
        let promptType = "detailed"; // default to detailed responses

        if (inquiryType === "simple") {
            responseLimit = 50; // Limit response tokens for short inquiries
            promptType = "concise"; // Use concise responses
        }
        trimHistory(threadID);

        // Send the entire conversation history to OpenAI
        const response = await openai.chat.completions.create({
            model: "gpt-4",
            messages: chatHistories[threadID], // Pass the entire conversation history
            max_tokens: responseLimit
        });

        const aiResponse = response.choices[0].message.content;

        // Append the assistant's response to the history
        chatHistories[threadID].push({ role: "assistant", content: aiResponse });

        return aiResponse;
    } catch (error) {
        console.error("Error getting AI response: ", error);
        return "Sorry, I am having trouble responding at the moment.";
    }
}

// Function to fetch previous chats
async function fetchPreviousChats(api) {
    return new Promise((resolve, reject) => {
        api.getThreadList(20, null, ["INBOX"], (err, threads) => {
            if (err) return reject(err);
            resolve(threads);
        });
    });
}

function isOlderThanTwoDays(timestamp) {
    // const twoDaysInMilliseconds = 1 * 24 * 60 * 60 * 1000;
    // const now = new Date().getTime();
    // return now - parseInt(timestamp) > twoDaysInMilliseconds;
    const twelveHoursInMilliseconds = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
    const now = new Date().getTime(); // Current timestamp in milliseconds
    return now - parseInt(timestamp) > twelveHoursInMilliseconds; // Check if the timestamp is older than 12 hours
}

// Convert timestamp to human-readable format
function formatTimestamp(timestamp) {
    try {
        const date = new Date(parseInt(timestamp)); // Convert the timestamp from a string to a number
        if (isNaN(date)) throw new Error("Invalid date"); // Check for invalid date
        return format(date, "PPPpppp"); // Format the date using date-fns
    } catch (error) {
        return "Invalid timestamp"; // Fallback message for invalid timestamps
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function startListening() {
    return new Promise((resolve, reject) => {
        login({ appState: JSON.parse(fs.readFileSync("fbstate.json", "utf8")) },async (err, api) => {
            if (err) return console.error(err);
    
            api.setOptions({
                listenEvents: true,
                autoMarkRead: true,
                autoMarkDelivery: true,
                online: true,
                logLevel: 'silly'
            });
    
            // Log previous chat (thread) IDs and last message timestamps
            try {
                const previousChats = await fetchPreviousChats(api);
                console.log("Previous chats with last message timestamps:");
                previousChats.forEach(thread => {
                    const threadName = thread.name || "Unnamed";
                    const lastMessageTime = thread.lastMessageTimestamp ? formatTimestamp(thread.lastMessageTimestamp) : "No timestamp available";
                    console.log(`Thread ID: ${thread.threadID}, Name: ${threadName}, Last Message Time: ${lastMessageTime}`);
                });
            } catch (err) {
                console.error("Error fetching previous chats: ", err);
            }
    
            var stopListening = api.listenMqtt(async (err, event) => {
                if (err) {
                    console.error("Error while listening to MQTT:", err);
                    setTimeout(startListening, 5000); // Retry after 5 seconds on failure
                    resolve();
                    return;
                }
                api.markAsRead(event.threadID, (err) => {
                    if (err) console.error(err);
                });
                // console.log(event.args);

                switch (event.type) {
                    case "message":
                        console.log("Received message in thread:", event.threadID);
    
                        if (event.body === "/blacklist") {
                            blacklist.push(event.threadID);
                            // api.sendMessage("This thread has been blacklisted.", event.threadID);
                            return;
                        }

                        if (event.body === "/stop") {
                            api.sendMessage("Goodbye…", event.threadID);
                            return stopListening();
                        }
                        // console.log("event logged:",event)
                        // console.log("event of body:",event.body)
                        // console.log(event.args.length)
                        if(event.args.length !== 0 && !blacklist.includes(event.threadID)){
                            api.markAsRead(event.threadID, (err) => {
                                if (err) console.error(err);
                            });
                            var inquiryType = await detectInquiryType(event.body);
                            // var contactDetails = detectContactDetails(newMessage);
                            // if (contactDetails.foundEmail && contactDetails.foundPhone) {
                            //     // responseMessage = "Thank you for providing both your email and phone number. We will get back to you soon!";
                            // } else if (contactDetails.foundEmail) {
                            //     // responseMessage = "Thank you for providing your email address. We'll reach out to you shortly.";
                            //     console.log('email found: ', contactDetails.foundEmail)
                            // } else if (contactDetails.foundPhone) {
                            //     // responseMessage = "Thank you for providing your phone number. We'll contact you soon.";
                            //     console.log('phone found: ', contactDetails.foundEmail)
                            // }
    
                            // if (event.body === "/followup"){
                            //     try {
                            //         var previousChats = await fetchPreviousChats(api); // Fetch previous chats
                            //         console.log("Previous chats older than two days:");
                            //         previousChats.forEach(thread => {
                            //             const threadName = thread.name || "Unnamed"; // Handle missing names
                            //             const lastMessageTime = thread.lastMessageTimestamp ? thread.lastMessageTimestamp : null; // Get the timestamp
                                
                            //             // Check if the timestamp exists and is older than two days
                            //             if (lastMessageTime && isOlderThanTwoDays(lastMessageTime)) {
                            //                 const formattedTime = formatTimestamp(lastMessageTime); // Format the timestamp using the date-fns
                            //                 console.log(`Thread ID: ${thread.threadID}, Name: ${threadName}, Last Message Time: ${formattedTime}`);
                            //             }
                            //         });
                            //     } catch (err) {
                            //         console.error("Error fetching previous chats: ", err); // Log error if fetch fails
                            //     }
                            // }

                            api.sendTypingIndicator(event.threadID, async (err) => {
                                if (err) console.error(err);
                                // Delay for 1 second (simulate typing)
                                setTimeout(async () => {
                                    // Fetch AI response with chat history
                                    const aiResponse = await getAIResponse(event.threadID, event.body,inquiryType);
                                    // console.log(chatHistories)
                                    // Send AI response after typing indicator
                                    api.sendMessage(`${aiResponse}`, event.threadID);
                                }, 9000); // 1 second delay
                            });
                        }
    
                    case "event":
                        console.log("Event triggered:", event);
                        // break;
                }
            });
            resolve();
        }
    );
    // resolve();
    });
    // resolve();
}

async function reconnectWithRetry() {
    while (true) {
        try {
            console.log("Attempting to connect...");
            await startListening(); // Attempt connection
            console.log("Connected successfully!");
            break; // Break the loop once connected
        } catch (err) {
            console.error("Connection failed. Retrying in 5 seconds...");
            await sleep(5000); // Wait 5 seconds before retrying
        }
    }
}

reconnectWithRetry();
