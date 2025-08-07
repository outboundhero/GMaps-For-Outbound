// start of postbackHandler.js
import fetch from 'node-fetch';
import { kv } from '@vercel/kv';
import zlib from 'zlib';
import util from 'util';

const WEBHOOK_URL = process.env.WEBHOOK_URL;
const gunzip = util.promisify(zlib.gunzip);
const MAX_ITEMS_PER_CALL = 25;

if (!WEBHOOK_URL) {
  console.error('WEBHOOK_URL environment variable is not set');
  // Handle the error appropriately, maybe throw an error or set a default value
}

// Extract analytics data
function extractGeneralData(data) {
  // Check if the data object exists and has a valid tasks array
  if (!data || !data.tasks || !Array.isArray(data.tasks) || data.tasks.length === 0) {
    throw new Error('Invalid data structure: missing or empty tasks array');
  }
  // Get the first task from the tasks array
  const task = data.tasks[0];
  // Check if the task has a data property
  if (!task.data) {
    throw new Error('Invalid task structure: missing data');
  }
  
  // Extract location_code and keyword from the task data
  const locationCode = task.data.location_code;
  const keyword = task.data.keyword;
  
  // Ensure both locationCode and keyword are present
  if (!locationCode || !keyword) {
    throw new Error('Missing required data: location_code or keyword');
  }
  
  // Initialize allPlaceIds as an empty array
  let allPlaceIds = [];
  
  // Check if the result exists and has items
  
  // This complex condition ensures we only process data when it's available
  if (task.result && Array.isArray(task.result) && task.result.length > 0 &&
      task.result[0].items && Array.isArray(task.result[0].items)) {
    // If items exist, map over them to extract place_ids
    allPlaceIds = task.result[0].items.map(item => item.place_id);
  }

  // Return an object with locationCode, keyword, and allPlaceIds
  // allPlaceIds will be an empty array if no items were found
  return { locationCode, keyword, allPlaceIds };
}

function formatWorkHours(item) {
  // Check if the item has work_hours
  if (!item.work_hours || !item.work_hours.timetable) {
    return item;
  }

  const timetable = item.work_hours.timetable;
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  
  // Process each day in the timetable
  days.forEach(day => {
    if (timetable[day] && Array.isArray(timetable[day])) {
      timetable[day].forEach(timeSlot => {
        // Format opening time
        if (timeSlot.open && typeof timeSlot.open.hour === 'number' && typeof timeSlot.open.minute === 'number') {
          timeSlot.open.time = `${timeSlot.open.hour}:${timeSlot.open.minute.toString().padStart(2, '0')}`;
        }
        
        // Format closing time
        if (timeSlot.close && typeof timeSlot.close.hour === 'number' && typeof timeSlot.close.minute === 'number') {
          timeSlot.close.time = `${timeSlot.close.hour}:${timeSlot.close.minute.toString().padStart(2, '0')}`;
        }
      });
    }
  });
  
  return item;
}

async function processPlaceIds(items, keyword, locationCode) {
  const totalItems = items.length;

  // Keep all place IDs, including null values
  const allPlaceIds = items.map(item => item.place_id);

  // Comment out Redis operations
  /*
  // Get existing unique place IDs for this keyword
  const keywordKey = `keyword:${keyword}:placeIds`;
  const existingKeywordPlaceIds = new Set(await kv.smembers(keywordKey));

  // Filter out null values and find new unique IDs only for Redis
  const newUniquePlaceIds = allPlaceIds.filter(id => id != null && !existingKeywordPlaceIds.has(id));

  // Update the set in the database only if there are new unique IDs
  if (newUniquePlaceIds.length > 0) {
    try {
      await kv.sadd(keywordKey, ...newUniquePlaceIds);
    } catch (error) {
      console.error('Error adding place IDs to Redis:', error);
    }
  }

  // Get existing unique place IDs for this location code within the keyword
  const locationCodeKey = `keyword:${keyword}:location:${locationCode}:placeIds`;
  const existingLocationCodePlaceIds = new Set(await kv.smembers(locationCodeKey));

  // Filter out null values and find new unique location code IDs only for Redis
  const newUniqueLocationCodePlaceIds = allPlaceIds.filter(id => id != null && !existingLocationCodePlaceIds.has(id));

  // Update the location code set in the database only if there are new unique IDs
  if (newUniqueLocationCodePlaceIds.length > 0) {
    try {
      await kv.sadd(locationCodeKey, ...newUniqueLocationCodePlaceIds);
    } catch (error) {
      console.error('Error adding location code place IDs to Redis:', error);
    }
  }

  // Update analytics data
  await updateAnalytics(keyword, locationCode, totalItems, newUniquePlaceIds.length, newUniqueLocationCodePlaceIds.length);
  */

  return {
    totalItems,
    uniquePlaceIds: allPlaceIds.filter(id => id != null).length
  };
}

// async function updateAnalytics(keyword, locationCode, totalItems, uniquePlaceIds, uniqueLocationCodePlaceIds) {
  // Comment out Redis operations
  /*
  const analyticsKey = `analytics:${keyword}:${locationCode}`;
  await kv.hset(analyticsKey, {
    totalItems: await kv.hincrby(analyticsKey, 'totalItems', totalItems),
    uniquePlaceIds: await kv.hincrby(analyticsKey, 'uniquePlaceIds', uniquePlaceIds),
    uniqueLocationCodePlaceIds: await kv.hincrby(analyticsKey, 'uniqueLocationCodePlaceIds', uniqueLocationCodePlaceIds),
    lastUpdated: new Date().toISOString()
  });
  
}
*/

export default async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const { id } = req.query;
      let data;

      if (req.headers['content-encoding'] === 'gzip') {
        const buffer = await getRawBody(req);
        const decompressed = await gunzip(buffer);
        data = JSON.parse(decompressed.toString());
      } else {
        data = req.body;
      }

      console.log('Received postback data for task:', id);

      // Extract general data
      const { locationCode, keyword, allPlaceIds } = extractGeneralData(data);

      // Retrieve the original task data from the database
      let extra = null;
      let customWebhook = null;
      
      try {
      // Use the correct ID from the data structure
      const taskId = data.tasks[0].id;
      const originalTaskData = await kv.get(`task:${taskId}`);
      console.log('Retrieved original task data for task:', taskId);
      console.log('Original task data:', originalTaskData);
      extra = originalTaskData?.originalData?.extra || null;
      customWebhook = originalTaskData?.originalData?.webhook || null;
    } catch (error) {
      console.error('Error retrieving original task data:', error);
    }
    
    console.log('Extracted extra object:', extra);
    console.log('Custom webhook URL:', customWebhook);

      // Determine which webhook URL to use
      const webhookUrl = customWebhook || WEBHOOK_URL;
  

      // Comment out or remove Redis operations
      /*
      // Store the extracted general data
      await kv.set(`task_general_data:${id}`, {
        locationCode,
        keyword,
        allPlaceIds,
        updatedAt: new Date().toISOString()
      });

      // Keep the existing storage of full data
      await kv.set(`task_result:${id}`, {
        status: 'completed',
        result: data,
        updatedAt: new Date().toISOString()
      });
      */

      // Extract items from the data structure
      const items = data.tasks[0].result[0].items;

      // Check if items exist and is an array before processing
      if (!items || !Array.isArray(items)) {
        console.log('No items found in the result, skipping processing');
        res.status(200).json({ success: true, message: 'Postback received but no items to process' });
        return;
      }

      // Process work hours for each item
      const processedItems = items.map(item => formatWorkHours(item));

      // Process place_ids for the entire response
      const { totalItems, uniquePlaceIds } = await processPlaceIds(items, keyword, locationCode);

      // Split items into chunks of 50
      const chunks = splitIntoChunks(items, MAX_ITEMS_PER_CALL);

      // Send each chunk to the webhook
      for (let i = 0; i < chunks.length; i++) {
        const chunkData = {
          ...data,
          tasks: [{
            ...data.tasks[0],
            result: [{
              ...data.tasks[0].result[0],
              items: chunks[i]
            }]
          }]
        };

        console.log('Sending webhook payload:', {
        taskId: id,
        chunkIndex: i + 1,
        totalChunks: chunks.length,
        totalItems,
        uniquePlaceIds,
        extra
      });

        const webhookResponse = await sendWithRetry(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          taskId: id,
          chunkIndex: i + 1,
          totalChunks: chunks.length,
          totalItems,
          uniquePlaceIds,
          postbackData: chunkData,
          extra
        })
      });

        if (!webhookResponse.ok) {
          throw new Error(`Webhook forwarding failed for chunk ${i + 1}: ${webhookResponse.statusText}`);
        }

        console.log(`Chunk ${i + 1}/${chunks.length} forwarded to webhook`);
      }

      res.status(200).json({ success: true, message: 'Postback received and processed' });
    } catch (error) {
      console.error('Error processing postback:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  } else {
    res.setHeader('Allow', ['POST']);
    res.status(405).end(`Method ${req.method} Not Allowed`);
  }
}

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    req.on('data', (chunk) => body.push(chunk));
    req.on('end', () => resolve(Buffer.concat(body)));
    req.on('error', reject);
  });
}

function splitIntoChunks(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function sendWithRetry(url, options, retries = 10) {
  for (let attempt = 0; attempt < retries; attempt++) {
    console.log(`Attempt ${attempt + 1}/${retries}: Making request to ${url}`);
    
    const response = await fetch(url, options);
    
    // Log the raw response details
    console.log(`Response status: ${response.status} ${response.statusText}`);
    console.log(`Response headers:`, Object.fromEntries(response.headers.entries()));
    
    // If not rate limited, handle the response
    if (response.status !== 429) {
      // Try to get response body for logging (if it's not too large)
      try {
        const responseText = await response.text();
        console.log(`Response body:`, responseText);
        
        // Create a new response object with the same properties
        return new Response(responseText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch (error) {
        console.log(`Could not read response body:`, error.message);
        // If we can't read the body, return the original response
        return response;
      }
    }
    
    // Handle rate limiting (429)
    // Wait before retrying with exponential backoff: 1s, 2s, 4s, 8s, ...
    const waitTime = 1000 * Math.pow(2, attempt); // attempt starts at 0
    console.log(`Rate limited (429). Waiting ${waitTime}ms before retry...`);
    await sleep(waitTime);
  }
  throw new Error('Too many requests, even after retries');
}
// end of postbackHandler.js
