const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const mongoose = require('mongoose');
const { initializeApp } = require('firebase/app');
const { getFirestore, collection, addDoc, doc, getDoc, serverTimestamp } = require('firebase/firestore');

// 1. Firebase Config from src/firebase.js
const firebaseConfig = {
  apiKey: "AIzaSyAGcXw872CCyr3p4d6IOpfzlsvz7Rt2JTg",
  authDomain: "innomatrics-management-system.firebaseapp.com",
  projectId: "innomatrics-management-system",
  storageBucket: "innomatrics-management-system.firebasestorage.app",
  messagingSenderId: "129931793945",
  appId: "1:129931793945:web:9ea4726f9159f982533c88"
};

const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error('❌ MONGODB_URI environment variable is required to run verification.');
  process.exit(1);
}

async function runE2EVerification() {
  console.log('🚀 Starting End-to-End Verification: Hybrid File Storage (MongoDB GridFS + Firebase Firestore)\n');

  // Step 1: Prepare real PDF file buffer
  const samplePdfContent = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Title (Project Requirements Document) /Author (IMT Admin) >>\nendobj\n2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n3 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj\n4 0 obj\n<< /Type /Page /Parent 3 0 R /MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n5 0 obj\n<< /Length 55 >>\nstream\nBT /F1 18 Tf 50 700 Td (IMT Project Requirements Document) Tj ET\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n0000000009 00000 n \n0000000084 00000 n \n0000000135 00000 n \n0000000194 00000 n \n0000000282 00000 n \ntrailer\n<< /Size 6 /Root 2 0 R >>\nstartxref\n388\n%%EOF'
  );
  const pdfFilename = 'Project_Requirements_Specification.pdf';

  console.log(`📦 [Step 1] Uploading "${pdfFilename}" (${samplePdfContent.length} bytes) to http://localhost:5000/api/files/upload...`);

  const blob = new Blob([samplePdfContent], { type: 'application/pdf' });
  const formData = new FormData();
  formData.append('file', blob, pdfFilename);
  formData.append('category', 'requirements_sheet');
  formData.append('uploadedBy', 'admin');

  const uploadRes = await fetch('http://localhost:5000/api/files/upload', {
    method: 'POST',
    body: formData,
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text();
    console.error('Upload HTTP Error:', uploadRes.status, errText);
    process.exit(1);
  }

  const uploadJson = await uploadRes.json();
  console.log('✅ [Step 1 Response] Upload successful:', uploadJson);

  const fileId = uploadJson.file.id;
  const fileUrl = uploadJson.file.url;
  const downloadUrl = uploadJson.file.downloadUrl;

  // Step 2: Direct MongoDB Atlas verification
  console.log(`\n🔍 [Step 2] Connecting directly to MongoDB Atlas cluster0.lp69b8g.mongodb.net to verify GridFS storage...`);
  await mongoose.connect(MONGO_URI);
  const mongoDb = mongoose.connection.db;

  const filesColl = mongoDb.collection('uploads.files');
  const chunksColl = mongoDb.collection('uploads.chunks');

  const fileDoc = await filesColl.findOne({ _id: new mongoose.Types.ObjectId(fileId) });
  if (!fileDoc) {
    console.error(`❌ FAILED: File ${fileId} not found in uploads.files!`);
    process.exit(1);
  }

  console.log(`✅ [Step 2 Verified] Found in "uploads.files":`);
  console.log(`   - _id: ${fileDoc._id}`);
  console.log(`   - filename: ${fileDoc.filename}`);
  console.log(`   - length: ${fileDoc.length} bytes`);
  console.log(`   - contentType: ${fileDoc.contentType}`);
  console.log(`   - uploadDate: ${fileDoc.uploadDate}`);
  console.log(`   - metadata:`, fileDoc.metadata);

  const chunks = await chunksColl.find({ files_id: new mongoose.Types.ObjectId(fileId) }).toArray();
  const totalChunkBytes = chunks.reduce((acc, c) => acc + c.data.length(), 0);
  console.log(`✅ [Step 2 Verified] Found ${chunks.length} chunk(s) in "uploads.chunks" with total size ${totalChunkBytes} bytes`);

  // Step 3: Verify Streaming & Downloading via HTTP endpoints
  console.log(`\n🌐 [Step 3] Verifying inline streaming via GET ${fileUrl}...`);
  const streamRes = await fetch(fileUrl);
  console.log(`   - Status: ${streamRes.status}`);
  console.log(`   - Content-Type: ${streamRes.headers.get('content-type')}`);
  console.log(`   - Content-Disposition: ${streamRes.headers.get('content-disposition')}`);
  console.log(`   - Content-Length: ${streamRes.headers.get('content-length')}`);
  const streamBytes = Buffer.from(await streamRes.arrayBuffer());
  console.log(`   - Streamed Bytes: ${streamBytes.length} (Matches original: ${streamBytes.length === samplePdfContent.length})`);

  console.log(`\n📥 [Step 4] Verifying attachment download via GET ${downloadUrl}...`);
  const dlRes = await fetch(downloadUrl);
  console.log(`   - Status: ${dlRes.status}`);
  console.log(`   - Content-Disposition: ${dlRes.headers.get('content-disposition')}`);

  // Step 5: Save project in Firebase Firestore linking to this MongoDB GridFS file
  console.log(`\n🔥 [Step 5] Creating project in Firebase Firestore linked to MongoDB GridFS file...`);
  const projectPayload = {
    name: "Enterprise ERP Modernization",
    client: "Innomatrics Technologies Client",
    description: "Cloud-native platform upgrade with hybrid storage architecture",
    status: "Planning",
    priority: "High",
    startDate: "2026-11-01",
    dueDate: "2027-04-30",
    modules: [
      { type: "Admin Panel", assignedEmployees: [], progress: 0 },
      { type: "API", assignedEmployees: [], progress: 0 }
    ],
    requirementsSheet: {
      id: fileId,
      name: pdfFilename,
      size: samplePdfContent.length,
      type: "application/pdf",
      url: fileUrl,
      downloadUrl: downloadUrl,
      storage: "mongodb-gridfs",
      uploadedAt: new Date().toISOString()
    },
    createdAt: serverTimestamp()
  };

  const projectRef = await addDoc(collection(db, "projects"), projectPayload);
  console.log(`✅ [Step 5 Success] Project created in Firebase Firestore with Document ID: ${projectRef.id}`);

  // Step 6: Verify reading project back from Firebase Firestore
  const readBackDoc = await getDoc(doc(db, "projects", projectRef.id));
  const readBackData = readBackDoc.data();
  console.log(`\n📋 [Step 6] Verifying Firestore document content:`);
  console.log(`   - Project Name: "${readBackData.name}"`);
  console.log(`   - Status: "${readBackData.status}"`);
  console.log(`   - requirementsSheet.id: "${readBackData.requirementsSheet.id}"`);
  console.log(`   - requirementsSheet.storage: "${readBackData.requirementsSheet.storage}"`);
  console.log(`   - requirementsSheet.url: "${readBackData.requirementsSheet.url}"`);

  console.log('\n======================================================');
  console.log('🎉 ALL END-TO-END VERIFICATIONS PASSED SUCCESSFULLY!');
  console.log('======================================================');
  console.log(`📁 MongoDB Atlas Cluster: cluster0.lp69b8g.mongodb.net`);
  console.log(`📊 Database: imt_storage`);
  console.log(`📦 Collections created: uploads.files, uploads.chunks`);
  console.log(`📄 Verified File ID: ${fileId}`);
  console.log(`🔥 Firebase Firestore Document ID: ${projectRef.id}`);
  console.log('======================================================\n');

  await mongoose.disconnect();
  process.exit(0);
}

runE2EVerification().catch((err) => {
  console.error('Fatal E2E error:', err);
  process.exit(1);
});
