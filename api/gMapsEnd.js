// gMapsEnd.js
import fetch from 'node-fetch';
import { kv } from '@vercel/kv';

// RateLimiter implementation moved here to remove external dependency
class RateLimiter {
  constructor(limit, window) {
    this.limit = limit; // maximum number of requests
    this.window = window; // time window in seconds
  }

  async isAllowed(key) {
    const now = Date.now();
    const windowStart = now - this.window * 1000;

    let requests = await kv.get(`ratelimit:${key}`) || [];
    requests = requests.filter(time => time > windowStart);

    if (requests.length < this.limit) {
      requests.push(now);
      await kv.set(`ratelimit:${key}`, requests, { ex: this.window });
      return true;
    }

    return false;
  }
}

const rateLimiter = new RateLimiter(1000, 60); // 1000 requests per minute

const API_URL = process.env.API_URL;
const LOGIN = process.env.API_LOGIN;
const PASSWORD = process.env.API_PASSWORD;
const BASE_POSTBACK_URL = process.env.BASE_POSTBACK_URL;

if (!API_URL || !LOGIN || !PASSWORD || !BASE_POSTBACK_URL) {
  console.error('One or more required environment variables are not set');
  // Handle the error appropriately, maybe throw an error or set default values
}

function getValidTokens() {
  const tokenKeys = Object.keys(process.env).filter(key => key.startsWith('AUTH_TOKEN_'));
  return tokenKeys.map(key => process.env[key]);
}

function isValidToken(token) {
  const validTokens = getValidTokens();
  if (validTokens.length === 0) {
    console.error('No valid tokens found in environment variables');
    return false;
  }
  const isValid = validTokens.includes(token);
  console.log('Is token valid?', isValid);
  return isValid;
}

function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function isValidRequestBody(body) {
  console.log('Validating request body:', JSON.stringify(body));

  let item;
  if (Array.isArray(body) && body.length === 1) {
    item = body[0];
  } else if (typeof body === 'object' && body !== null && '0' in body) {
    item = body['0'];
  } else {
    console.log('Body is not an array with one item or an object with a "0" key');
    return false;
  }

  console.log('Validating item:', JSON.stringify(item));

  const isValid = (
    typeof item.language_code === 'string' &&
    (typeof item.location_code === 'number' || typeof item.location_code === 'string') &&
    typeof item.keyword === 'string' &&
    typeof item.depth === 'number' &&
    item.postback_data === 'advanced' &&
    (item.webhook === undefined || typeof item.webhook === 'string')
    // Remove the specific validation for extra
  );

  if (!isValid) {
    console.log('Invalid fields:');
    console.log('language_code:', typeof item.language_code);
    console.log('location_code:', typeof item.location_code);
    console.log('keyword:', typeof item.keyword);
    console.log('depth:', typeof item.depth);
    console.log('postback_data:', item.postback_data);
    console.log('webhook:', item.webhook);
    return false;
  }

  // If extra is present, log it without validation
  if (item.extra !== undefined) {
    console.log('Extra data:', JSON.stringify(item.extra));
  }

  return [item];
}

// async function isDuplicateRequest(body) {
//   const key = `request:${body[0].language_code}:${body[0].location_code}:${body[0].keyword}:${body[0].depth}`;
//   const existingRequest = await kv.get(key);
//   return !!existingRequest;
// }

// async function saveRequestHash(body) {
//  const key = `request:${body[0].language_code}:${body[0].location_code}:${body[0].keyword}:${body[0].depth}`;
//  await kv.set(key, true, { ex: 86400 }); // Set to expire after 24 hours
// }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  console.log('Received request body:', JSON.stringify(req.body));  
  const authToken = req.headers.authentication;

  if (!authToken || !isValidToken(authToken)) {
    return res.status(401).json({ success: false, error: "Unauthorized: Invalid or missing token" });
  }

  const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  if (!(await rateLimiter.isAllowed(clientIp))) {
    return res.status(429).json({ success: false, error: "Rate limit exceeded. Please try again later." });
  }

  try {
    const uniqueId = generateUniqueId();
    const validBody = isValidRequestBody(req.body);
    
    if (!validBody) {
      return res.status(400).json({ success: false, error: "body data not correct" });
    }

    // if (await isDuplicateRequest(validBody)) {
    //  return res.status(409).json({ success: false, error: "Duplicate request. This exact query has been processed recently." });
    // }

    const dynamicBody = validBody.map(item => ({
      ...item,
      postback_url: `${BASE_POSTBACK_URL}${uniqueId}`
    }));

    const postResponse = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(dynamicBody)
    });

    const postData = await postResponse.json();
    console.log('API Response:', postData);

    if (!postData.tasks || postData.tasks.length === 0 || !postData.tasks[0].id) {
      throw new Error('No task ID received from API');
    }

    const taskId = postData.tasks[0].id;

    await kv.set(`task:${taskId}`, {
      status: 'pending',
      originalData: validBody[0], // This now includes the 'extra' object
      createdAt: new Date().toISOString(),
      uniqueId: uniqueId
    });

    // await saveRequestHash(validBody);

    try {
      const tokenIndex = getValidTokens().indexOf(authToken);
      await kv.incr(`api_calls:token${tokenIndex + 1}`);
      await kv.lpush(`api_calls:uniqueIds:token${tokenIndex + 1}`, uniqueId);
    } catch (counterError) {
      console.error('Error incrementing API call counter:', counterError);
    }

    res.status(200).json({ success: true, taskId: taskId, uniqueId: uniqueId });
  } catch (error) {
    console.error('Error in gMapsEnd:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}
