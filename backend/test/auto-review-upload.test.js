const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express'), request = require('supertest');
process.env.AUTO_REVIEW_MAX_TOTAL_BYTES = '1000';
process.env.AUTO_REVIEW_MAX_FILE_BYTES = '1024';
const batches = require('../pilot/auto-review-batch');
test('multipart aggregate limit aborts during streaming before persistence', async () => {
  const app = express(); let databaseCalls = 0;
  app.use((req,_res,next)=>{req.user={id:'test',roles:['admin']};next();});
  const router=express.Router();batches.mountRoutes(router,()=>{databaseCalls++;throw Error('Persistence must not start');});app.use(router);
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({code:error.code,message:error.message}));
  const response=await request(app).post('/auto-review-batches').attach('files[]',Buffer.alloc(600),'one.docx').attach('files[]',Buffer.alloc(600),'two.docx').expect(413);
  assert.equal(response.body.code,'AUTO_REVIEW_TOTAL_LIMIT');assert.equal(databaseCalls,0);
  const limits=await request(app).get('/auto-review-limits').expect(200);assert.equal(limits.body.maxTotalBytes,1000);assert.equal(limits.body.maxFileBytes,1024);
});
