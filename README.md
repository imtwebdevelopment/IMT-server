# IMT Server

Backend API service for the IMT Management System featuring Hybrid File Storage with MongoDB GridFS and RESTful endpoints.

## Features

- **MongoDB GridFS Storage**: Efficient streaming upload, download, replacement, and deletion of large files (PDF, DOCX, XLSX, Images, etc.).
- **Health Monitoring**: Dedicated health check endpoint reporting MongoDB cluster status and collection states.
- **RESTful File Endpoints**:
  - `POST /api/files/upload`: Single and bulk file uploads with category metadata.
  - `GET /api/files/:id`: Stream/download files by GridFS file ID.
  - `GET /api/files/:id/view`: Inline view with automatic Content-Type headers for browser preview.
  - `GET /api/files/:id/meta`: Fetch file metadata (size, uploadDate, contentType, custom metadata).
  - `DELETE /api/files/:id`: Delete a file from GridFS storage.
  - `POST /api/files/replace/:id`: Atomic file replacement.
  - `GET /api/health`: Database connection and storage health status.

## Getting Started

### Prerequisites

- Node.js (v18+)
- MongoDB Atlas connection string (or local MongoDB with Replica Set)

### Installation

1. Clone repository:
   ```bash
   git clone https://github.com/imtwebdevelopment/IMT-server.git
   cd IMT-server
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Setup environment variables:
   Copy `.env.example` to `.env` and fill in your connection string:
   ```bash
   cp .env.example .env
   ```

4. Start development server:
   ```bash
   npm run dev
   ```

5. Run test suite:
   ```bash
   npm test
   ```
