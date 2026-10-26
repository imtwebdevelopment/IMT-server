const mongoose = require('mongoose');
const dns = require('dns');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {}

process.env.NODE_ENV = 'test';
const app = require('../server');

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌ MONGODB_URI environment variable is required to run tests.');
  process.exit(1);
}

async function runTests() {
  console.log('🧪 Starting Hybrid Storage (MongoDB GridFS) Test Suite...\n');

  let passed = 0;
  let failed = 0;

  const assert = (condition, testName) => {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}`);
      failed++;
    }
  };

  // 1. Database Connection Test
  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    }
    // Wait until connection is open
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve) => mongoose.connection.once('open', resolve));
    }
    assert(mongoose.connection.readyState === 1, 'MongoDB Connected successfully');
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message);
    process.exit(1);
  }

  const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName: process.env.GRIDFS_BUCKET_NAME || 'uploads',
  });
  assert(!!bucket, 'GridFS Bucket initialized');

  // Helper to make mock requests to Express app or test GridFS directly
  const testFiles = [
    { name: 'test_requirements.pdf', type: 'application/pdf', content: '%PDF-1.4 sample pdf content for testing' },
    { name: 'sample_data.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: 'PK sample excel spreadsheet binary mock' },
    { name: 'project_brief.docx', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content: 'PK sample word docx document binary mock' },
    { name: 'ui_mockup.png', type: 'image/png', content: '\x89PNG\r\n\x1a\n sample png image binary mock' },
  ];

  let uploadedFileIds = [];

  // 2. Test Uploading each file type (PDF, XLSX, DOCX, PNG) to GridFS
  for (const tf of testFiles) {
    try {
      const uploadStream = bucket.openUploadStream(tf.name, {
        contentType: tf.type,
        metadata: {
          originalName: tf.name,
          size: Buffer.byteLength(tf.content),
          mimeType: tf.type,
          category: 'requirements_sheet',
          uploadedAt: new Date(),
        },
      });

      await new Promise((resolve, reject) => {
        uploadStream.on('finish', resolve);
        uploadStream.on('error', reject);
        uploadStream.end(Buffer.from(tf.content));
      });

      const fileId = uploadStream.id.toString();
      uploadedFileIds.push({ id: fileId, name: tf.name, type: tf.type, size: Buffer.byteLength(tf.content) });

      assert(!!fileId && fileId.length === 24, `Uploaded ${tf.name} (${tf.type}) to GridFS [ID: ${fileId}]`);
    } catch (err) {
      assert(false, `Upload ${tf.name}: ${err.message}`);
    }
  }

  // 3. Test Metadata Retrieval from GridFS
  const sample = uploadedFileIds[0];
  try {
    const files = await bucket.find({ _id: new mongoose.Types.ObjectId(sample.id) }).toArray();
    assert(files.length === 1, `Metadata found for ${sample.name}`);
    assert(files[0].contentType === sample.type, `Content-Type matches: ${files[0].contentType}`);
    assert(files[0].metadata.originalName === sample.name, `Original filename matches: ${files[0].metadata.originalName}`);
  } catch (err) {
    assert(false, `Metadata check failed: ${err.message}`);
  }

  // 4. Test Streaming / Downloading from GridFS
  try {
    const downloadStream = bucket.openDownloadStream(new mongoose.Types.ObjectId(sample.id));
    const chunks = [];
    await new Promise((resolve, reject) => {
      downloadStream.on('data', (c) => chunks.push(c));
      downloadStream.on('end', resolve);
      downloadStream.on('error', reject);
    });

    const downloadedContent = Buffer.concat(chunks).toString();
    assert(downloadedContent === testFiles[0].content, `Streamed/Downloaded content matches original file content`);
  } catch (err) {
    assert(false, `Download stream failed: ${err.message}`);
  }

  // 5. Test Replacing File in GridFS
  try {
    const oldId = uploadedFileIds[1].id;
    const replacementName = 'updated_spreadsheet.xlsx';
    const replacementContent = 'PK updated excel spreadsheet content';

    // Upload replacement
    const repUploadStream = bucket.openUploadStream(replacementName, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      metadata: { originalName: replacementName, replacedFileId: oldId },
    });

    await new Promise((resolve, reject) => {
      repUploadStream.on('finish', resolve);
      repUploadStream.on('error', reject);
      repUploadStream.end(Buffer.from(replacementContent));
    });

    const newId = repUploadStream.id.toString();

    // Delete old
    await bucket.delete(new mongoose.Types.ObjectId(oldId));

    // Verify old is deleted
    const oldFiles = await bucket.find({ _id: new mongoose.Types.ObjectId(oldId) }).toArray();
    // Verify new exists
    const newFiles = await bucket.find({ _id: new mongoose.Types.ObjectId(newId) }).toArray();

    assert(oldFiles.length === 0, `Old file ${oldId} was deleted during replace`);
    assert(newFiles.length === 1 && newFiles[0].filename === replacementName, `New replacement file ${newId} exists in GridFS`);

    // Clean up new replacement file
    await bucket.delete(new mongoose.Types.ObjectId(newId));
  } catch (err) {
    assert(false, `Replace file failed: ${err.message}`);
  }

  // 6. Test File Deletion from GridFS
  for (const f of uploadedFileIds) {
    try {
      const objId = new mongoose.Types.ObjectId(f.id);
      const existing = await bucket.find({ _id: objId }).toArray();
      if (existing.length > 0) {
        await bucket.delete(objId);
        const checkAfter = await bucket.find({ _id: objId }).toArray();
        assert(checkAfter.length === 0, `Cleaned up and deleted ${f.name} from GridFS`);
      }
    } catch (err) {
      assert(false, `Delete ${f.name}: ${err.message}`);
    }
  }

  // 7. Verify nonexistent file returns empty
  try {
    const fakeId = new mongoose.Types.ObjectId();
    const fakeResult = await bucket.find({ _id: fakeId }).toArray();
    assert(fakeResult.length === 0, `Nonexistent ID correctly returns no file`);
  } catch (err) {
    assert(false, `Nonexistent check failed: ${err.message}`);
  }

  console.log(`\n📊 Test Summary: ${passed} Passed, ${failed} Failed`);

  await mongoose.disconnect();

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('🎉 All GridFS Hybrid Storage Tests Passed!\n');
    process.exit(0);
  }
}

runTests();
