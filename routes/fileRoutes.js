const express = require('express');
const multer = require('multer');
const { Readable } = require('stream');
const mongoose = require('mongoose');

const router = express.Router();

// Multer memory storage (streams to GridFS)
const storage = multer.memoryStorage();

// Allowed MIME types & extensions
const ALLOWED_MIME_TYPES = new Set([
  // PDFs
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  // Images
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
]);

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'csv',
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'svg',
]);

const fileFilter = (req, file, cb) => {
  const ext = file.originalname.split('.').pop()?.toLowerCase();
  const isAllowedExt = ext && ALLOWED_EXTENSIONS.has(ext);
  const isAllowedMime = ALLOWED_MIME_TYPES.has(file.mimetype) || file.mimetype === 'application/octet-stream';

  if (isAllowedExt || isAllowedMime) {
    cb(null, true);
  } else {
    cb(
      new Error(
        `Invalid file type (${file.mimetype}). Allowed types: PDF, Word (DOC, DOCX), Excel (XLS, XLSX), and Images (JPG, PNG, WEBP, GIF, SVG).`
      ),
      false
    );
  }
};

const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter,
});

/**
 * Helper to get the GridFS bucket from active mongoose connection
 */
const getBucket = () => {
  if (!mongoose.connection.db) {
    throw new Error('Database connection is not ready. Waiting for MongoDB connection...');
  }
  const bucketName = process.env.GRIDFS_BUCKET_NAME || 'uploads';
  return new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
    bucketName,
  });
};

/**
 * Helper to get base URL (configurable via PUBLIC_API_URL or dynamic request host)
 */
const getBaseUrl = (req) => {
  if (process.env.PUBLIC_API_URL) {
    return process.env.PUBLIC_API_URL.replace(/\/+$/, '');
  }
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.get('host');
  return `${protocol}://${host}`;
};

/**
 * 1. POST /api/files/upload
 * Upload a single file directly into MongoDB GridFS
 */
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      console.warn('⚠️ [GridFS Upload] Request received with no file payload');
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const bucket = getBucket();
    const originalName = req.file.originalname;
    const sanitizedFilename = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    console.log(`⏳ [GridFS Upload] Streaming "${originalName}" (${(req.file.size / 1024).toFixed(1)} KB) into bucket "${bucket.s.options.bucketName}"...`);

    const uploadStream = bucket.openUploadStream(sanitizedFilename, {
      contentType: req.file.mimetype,
      metadata: {
        originalName: originalName,
        size: req.file.size,
        mimeType: req.file.mimetype,
        category: req.body.category || 'requirements_sheet',
        uploadedBy: req.body.uploadedBy || null,
        uploadedAt: new Date(),
      },
    });

    const readable = Readable.from(req.file.buffer);

    await new Promise((resolve, reject) => {
      readable.pipe(uploadStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    const fileId = uploadStream.id.toString();

    // Verify file actually exists in GridFS
    const verifiedDoc = await bucket.find({ _id: uploadStream.id }).next();
    if (!verifiedDoc) {
      throw new Error(`Upload stream finished but file ${fileId} was not found in GridFS bucket`);
    }

    console.log(`✅ [GridFS Upload Success] File verified in MongoDB: ID=${fileId}, Filename="${sanitizedFilename}", Size=${verifiedDoc.length} bytes`);

    const baseUrl = getBaseUrl(req);

    const fileData = {
      id: fileId,
      name: originalName,
      filename: sanitizedFilename,
      size: verifiedDoc.length,
      type: req.file.mimetype,
      url: `${baseUrl}/api/files/${fileId}`,
      downloadUrl: `${baseUrl}/api/files/${fileId}/download`,
      storage: 'mongodb-gridfs',
      uploadedAt: verifiedDoc.uploadDate ? verifiedDoc.uploadDate.toISOString() : new Date().toISOString(),
      metadata: {
        category: req.body.category || 'requirements_sheet',
        uploadedBy: req.body.uploadedBy || null,
        bucket: bucket.s.options.bucketName,
      },
    };

    return res.status(201).json({
      success: true,
      message: 'File successfully uploaded and verified in MongoDB GridFS',
      file: fileData,
    });
  } catch (error) {
    console.error('❌ [GridFS Upload Error]:', error.message);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload file to MongoDB GridFS',
    });
  }
});

/**
 * 2. GET /api/files/:id
 * Retrieve / stream file inline for preview
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid file ID format' });
    }

    const bucket = getBucket();
    const objectId = new mongoose.Types.ObjectId(id);

    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found in GridFS' });
    }

    const file = files[0];
    const originalName = file.metadata?.originalName || file.filename;

    res.set({
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Length': file.length,
      'Content-Disposition': `inline; filename="${encodeURIComponent(originalName)}"`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });

    const downloadStream = bucket.openDownloadStream(objectId);
    downloadStream.on('error', (err) => {
      console.error('Download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming file' });
      }
    });

    downloadStream.pipe(res);
  } catch (error) {
    console.error('GridFS Preview Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
});

/**
 * 3. GET /api/files/:id/download
 * Force download stream with attachment disposition
 */
router.get('/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid file ID format' });
    }

    const bucket = getBucket();
    const objectId = new mongoose.Types.ObjectId(id);

    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found in GridFS' });
    }

    const file = files[0];
    const originalName = file.metadata?.originalName || file.filename;

    res.set({
      'Content-Type': file.contentType || 'application/octet-stream',
      'Content-Length': file.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(originalName)}"`,
      'Cache-Control': 'public, max-age=86400',
    });

    const downloadStream = bucket.openDownloadStream(objectId);
    downloadStream.on('error', (err) => {
      console.error('Download stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error streaming file' });
      }
    });

    downloadStream.pipe(res);
  } catch (error) {
    console.error('GridFS Download Error:', error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, message: error.message });
    }
  }
});

/**
 * 4. GET /api/files/:id/metadata
 * Retrieve file metadata without downloading content
 */
router.get('/:id/metadata', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid file ID format' });
    }

    const bucket = getBucket();
    const objectId = new mongoose.Types.ObjectId(id);

    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found in GridFS' });
    }

    const file = files[0];
    const baseUrl = getBaseUrl(req);

    res.json({
      success: true,
      file: {
        id: file._id.toString(),
        name: file.metadata?.originalName || file.filename,
        filename: file.filename,
        size: file.length,
        type: file.contentType,
        url: `${baseUrl}/api/files/${file._id}`,
        downloadUrl: `${baseUrl}/api/files/${file._id}/download`,
        uploadedAt: file.uploadDate,
        storage: 'mongodb-gridfs',
        metadata: file.metadata || {},
      },
    });
  } catch (error) {
    console.error('GridFS Metadata Error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 5. PUT /api/files/:id/replace
 * Replace an existing file in GridFS with a new upload
 */
router.put('/:id/replace', upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid file ID format' });
    }

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No replacement file uploaded' });
    }

    const bucket = getBucket();
    const oldObjectId = new mongoose.Types.ObjectId(id);

    const originalName = req.file.originalname;
    const sanitizedFilename = `${Date.now()}_${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;

    console.log(`⏳ [GridFS Replace] Replacing file ${id} with "${originalName}"...`);

    const uploadStream = bucket.openUploadStream(sanitizedFilename, {
      contentType: req.file.mimetype,
      metadata: {
        originalName: originalName,
        size: req.file.size,
        mimeType: req.file.mimetype,
        category: req.body.category || 'requirements_sheet',
        replacedFileId: id,
        uploadedAt: new Date(),
      },
    });

    const readable = Readable.from(req.file.buffer);
    await new Promise((resolve, reject) => {
      readable.pipe(uploadStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    // Verify new file
    const verifiedNew = await bucket.find({ _id: uploadStream.id }).next();
    if (!verifiedNew) {
      throw new Error('New replacement file could not be verified in GridFS');
    }

    // Safely delete old file
    try {
      await bucket.delete(oldObjectId);
      console.log(`🗑️ [GridFS Replace] Deleted previous file ${id}`);
    } catch (delErr) {
      console.warn(`Warning: Could not delete old file ${id}:`, delErr.message);
    }

    const newFileId = uploadStream.id.toString();
    const baseUrl = getBaseUrl(req);

    const fileData = {
      id: newFileId,
      name: originalName,
      filename: sanitizedFilename,
      size: verifiedNew.length,
      type: req.file.mimetype,
      url: `${baseUrl}/api/files/${newFileId}`,
      downloadUrl: `${baseUrl}/api/files/${newFileId}/download`,
      storage: 'mongodb-gridfs',
      uploadedAt: verifiedNew.uploadDate ? verifiedNew.uploadDate.toISOString() : new Date().toISOString(),
      metadata: {
        category: req.body.category || 'requirements_sheet',
        replacedFileId: id,
        bucket: bucket.s.options.bucketName,
      },
    };

    return res.json({
      success: true,
      message: 'File replaced successfully in MongoDB GridFS',
      file: fileData,
    });
  } catch (error) {
    console.error('GridFS Replace Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * 6. DELETE /api/files/:id
 * Delete a file from MongoDB GridFS
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Invalid file ID format' });
    }

    const bucket = getBucket();
    const objectId = new mongoose.Types.ObjectId(id);

    // Verify existence before deletion
    const files = await bucket.find({ _id: objectId }).toArray();
    if (!files || files.length === 0) {
      return res.status(404).json({ success: false, message: 'File not found in GridFS' });
    }

    await bucket.delete(objectId);
    console.log(`🗑️ [GridFS Delete] File ${id} (${files[0].filename}) deleted successfully from GridFS`);

    return res.json({
      success: true,
      message: 'File successfully deleted from MongoDB GridFS',
      deletedId: id,
    });
  } catch (error) {
    console.error('GridFS Delete Error:', error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
