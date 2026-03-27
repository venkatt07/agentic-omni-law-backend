-- phpMyAdmin SQL Dump
-- version 5.2.1
-- https://www.phpmyadmin.net/
--
-- Host: 127.0.0.1
-- Generation Time: Feb 28, 2026 at 10:27 AM
-- Server version: 10.4.32-MariaDB
-- PHP Version: 8.0.30

SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";
START TRANSACTION;
SET time_zone = "+00:00";


/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;

--
-- Database: `agentic_omni_law`
--
CREATE DATABASE IF NOT EXISTS `agentic_omni_law` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `agentic_omni_law`;

-- --------------------------------------------------------

--
-- Table structure for table `agent_outputs`
--

DROP TABLE IF EXISTS `agent_outputs`;
CREATE TABLE IF NOT EXISTS `agent_outputs` (
  `id` varchar(191) NOT NULL,
  `case_id` varchar(191) NOT NULL,
  `agent_key` varchar(191) NOT NULL,
  `agent_kind` enum('common','role') NOT NULL DEFAULT 'common',
  `doc_id` varchar(191) DEFAULT NULL,
  `doc_hash` varchar(191) DEFAULT NULL,
  `output_lang` varchar(64) NOT NULL DEFAULT 'English',
  `profile` varchar(64) NOT NULL DEFAULT 'standard',
  `run_id` varchar(191) DEFAULT NULL,
  `status` enum('PENDING','RUNNING','SUCCEEDED','FAILED') DEFAULT NULL,
  `analysis_valid` tinyint(1) DEFAULT NULL,
  `failure_reason` text DEFAULT NULL,
  `payload_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`payload_json`)),
  `source_language` varchar(191) NOT NULL DEFAULT 'en',
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `agent_outputs_cache_key_uq` (`case_id`,`agent_key`,`doc_hash`,`output_lang`,`profile`),
  KEY `agent_outputs_case_id_idx` (`case_id`),
  KEY `idx_agent_outputs_case_agent_doc_hash_updated` (`case_id`,`agent_key`,`doc_hash`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `cases`
--

DROP TABLE IF EXISTS `cases`;
CREATE TABLE IF NOT EXISTS `cases` (
  `id` varchar(191) NOT NULL,
  `user_id` varchar(191) NOT NULL,
  `role` enum('LAWYER','LAW_STUDENT','BUSINESS_CORPORATE','NORMAL_PERSON') NOT NULL,
  `language` varchar(191) NOT NULL DEFAULT 'English',
  `detected_language` varchar(191) DEFAULT NULL,
  `filters_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`filters_json`)),
  `title` varchar(191) NOT NULL DEFAULT 'Untitled Case Workspace',
  `status` enum('active','archived') NOT NULL DEFAULT 'active',
  `domain_primary` varchar(191) DEFAULT NULL,
  `domain_subtype` varchar(191) DEFAULT NULL,
  `primary_doc_id` varchar(191) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `cases_user_id_updated_at_idx` (`user_id`,`updated_at`),
  KEY `cases_user_id_status_updated_at_idx` (`user_id`,`status`,`updated_at`),
  KEY `cases_primary_doc_id_idx` (`primary_doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `corpus_documents`
--

DROP TABLE IF EXISTS `corpus_documents`;
CREATE TABLE IF NOT EXISTS `corpus_documents` (
  `id` varchar(191) NOT NULL,
  `source_type` varchar(64) NOT NULL DEFAULT 'legal_corpus',
  `corpus_type` varchar(64) NOT NULL,
  `title` varchar(512) NOT NULL,
  `jurisdiction` varchar(32) NOT NULL DEFAULT 'IN',
  `file_path` varchar(1024) NOT NULL,
  `text_path` varchar(1024) DEFAULT NULL,
  `sha256` varchar(128) NOT NULL,
  `meta_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`meta_json`)),
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_corpus_documents_file_path` (`file_path`(255)),
  KEY `idx_corpus_documents_type` (`corpus_type`),
  KEY `idx_corpus_documents_sha` (`sha256`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `documents`
--

DROP TABLE IF EXISTS `documents`;
CREATE TABLE IF NOT EXISTS `documents` (
  `id` varchar(191) NOT NULL,
  `case_id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `mime` varchar(191) NOT NULL,
  `size` int(11) NOT NULL,
  `path` varchar(191) NOT NULL,
  `kind` enum('uploaded','pasted_text') NOT NULL DEFAULT 'uploaded',
  `checksum` varchar(191) NOT NULL,
  `indexed_checksum` varchar(191) DEFAULT NULL,
  `extracted_text` longtext DEFAULT NULL,
  `detected_language` varchar(191) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `documents_case_id_updated_at_idx` (`case_id`,`updated_at`),
  KEY `documents_checksum_idx` (`checksum`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `drafts`
--

DROP TABLE IF EXISTS `drafts`;
CREATE TABLE IF NOT EXISTS `drafts` (
  `draft_id` varchar(191) NOT NULL,
  `case_id` varchar(191) NOT NULL,
  `template_key` varchar(128) NOT NULL,
  `title` varchar(255) NOT NULL,
  `content` longtext NOT NULL,
  `suggestions_json` longtext DEFAULT NULL,
  `validation_json` longtext DEFAULT NULL,
  `citations_json` longtext DEFAULT NULL,
  `clarifying_questions_json` longtext DEFAULT NULL,
  `language` varchar(64) DEFAULT NULL,
  `jurisdiction` varchar(128) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'ready',
  `mode` varchar(32) NOT NULL DEFAULT 'fallback',
  `analysis_valid` tinyint(1) NOT NULL DEFAULT 0,
  `failure_reason` text DEFAULT NULL,
  `source_doc_hash` varchar(191) DEFAULT NULL,
  `run_id` varchar(191) DEFAULT NULL,
  `qa_debug_json` longtext DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  PRIMARY KEY (`draft_id`),
  KEY `idx_drafts_case_updated` (`case_id`,`updated_at`),
  KEY `idx_drafts_case_template` (`case_id`,`template_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `idempotency_locks`
--

DROP TABLE IF EXISTS `idempotency_locks`;
CREATE TABLE IF NOT EXISTS `idempotency_locks` (
  `lock_key` varchar(255) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  PRIMARY KEY (`lock_key`),
  KEY `idx_idempotency_locks_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `index_chunks`
--

DROP TABLE IF EXISTS `index_chunks`;
CREATE TABLE IF NOT EXISTS `index_chunks` (
  `id` varchar(191) NOT NULL,
  `case_id` varchar(191) NOT NULL,
  `doc_id` varchar(191) NOT NULL,
  `chunk_id` varchar(191) NOT NULL,
  `chunk_text` longtext NOT NULL,
  `meta_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`meta_json`)),
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `index_chunks_case_id_doc_id_chunk_id_key` (`case_id`,`doc_id`,`chunk_id`),
  KEY `index_chunks_case_id_idx` (`case_id`),
  KEY `index_chunks_doc_id_fkey` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `notifications`
--

DROP TABLE IF EXISTS `notifications`;
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` varchar(191) NOT NULL,
  `user_id` varchar(191) NOT NULL,
  `title` varchar(191) NOT NULL,
  `body` text NOT NULL,
  `read_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `notifications_user_id_created_at_idx` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `otps`
--

DROP TABLE IF EXISTS `otps`;
CREATE TABLE IF NOT EXISTS `otps` (
  `id` varchar(191) NOT NULL,
  `user_id` varchar(191) NOT NULL,
  `code_hash` varchar(191) NOT NULL,
  `expires_at` datetime(3) NOT NULL,
  `attempts` int(11) NOT NULL DEFAULT 0,
  `last_sent_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `otps_user_id_created_at_idx` (`user_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `runs`
--

DROP TABLE IF EXISTS `runs`;
CREATE TABLE IF NOT EXISTS `runs` (
  `id` varchar(191) NOT NULL,
  `case_id` varchar(191) NOT NULL,
  `status` enum('PENDING','RUNNING','SUCCEEDED','FAILED') NOT NULL DEFAULT 'PENDING',
  `language` varchar(191) DEFAULT NULL,
  `steps_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`steps_json`)),
  `started_at` datetime(3) DEFAULT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `runs_case_id_status_idx` (`case_id`,`status`),
  KEY `runs_case_id_created_at_idx` (`case_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
CREATE TABLE IF NOT EXISTS `users` (
  `id` varchar(191) NOT NULL,
  `name` varchar(191) NOT NULL,
  `email` varchar(191) NOT NULL,
  `phone` varchar(191) DEFAULT NULL,
  `gender` varchar(32) DEFAULT NULL,
  `date_of_birth` date DEFAULT NULL,
  `password_hash` varchar(191) NOT NULL,
  `role` enum('LAWYER','LAW_STUDENT','BUSINESS_CORPORATE','NORMAL_PERSON') NOT NULL,
  `is_verified` tinyint(1) NOT NULL DEFAULT 0,
  `preferred_language` varchar(191) NOT NULL DEFAULT 'English',
  `active_case_id` varchar(191) DEFAULT NULL,
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `users_email_key` (`email`),
  UNIQUE KEY `users_phone_key` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `vector_chunks`
--

DROP TABLE IF EXISTS `vector_chunks`;
CREATE TABLE IF NOT EXISTS `vector_chunks` (
  `id` varchar(191) NOT NULL,
  `doc_id` varchar(191) NOT NULL,
  `case_id` varchar(191) DEFAULT NULL,
  `source_type` varchar(64) NOT NULL,
  `corpus_type` varchar(64) DEFAULT NULL,
  `chunk_id` varchar(191) NOT NULL,
  `page` int(11) DEFAULT NULL,
  `offset_start` int(11) DEFAULT NULL,
  `offset_end` int(11) DEFAULT NULL,
  `chunk_text` longtext NOT NULL,
  `embedding_json` longtext DEFAULT NULL,
  `metadata_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata_json`)),
  `created_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `updated_at` datetime(3) NOT NULL DEFAULT current_timestamp(3) ON UPDATE current_timestamp(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_vector_chunks_doc_chunk` (`doc_id`,`chunk_id`),
  KEY `idx_vector_chunks_source` (`source_type`),
  KEY `idx_vector_chunks_case` (`case_id`),
  KEY `idx_vector_chunks_doc` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- --------------------------------------------------------

--
-- Table structure for table `_prisma_migrations`
--

DROP TABLE IF EXISTS `_prisma_migrations`;
CREATE TABLE IF NOT EXISTS `_prisma_migrations` (
  `id` varchar(36) NOT NULL,
  `checksum` varchar(64) NOT NULL,
  `finished_at` datetime(3) DEFAULT NULL,
  `migration_name` varchar(255) NOT NULL,
  `logs` text DEFAULT NULL,
  `rolled_back_at` datetime(3) DEFAULT NULL,
  `started_at` datetime(3) NOT NULL DEFAULT current_timestamp(3),
  `applied_steps_count` int(10) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

--
-- Constraints for dumped tables
--

--
-- Constraints for table `agent_outputs`
--
ALTER TABLE `agent_outputs`
  ADD CONSTRAINT `agent_outputs_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `cases`
--
ALTER TABLE `cases`
  ADD CONSTRAINT `cases_primary_doc_id_fkey` FOREIGN KEY (`primary_doc_id`) REFERENCES `documents` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `cases_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `documents`
--
ALTER TABLE `documents`
  ADD CONSTRAINT `documents_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `index_chunks`
--
ALTER TABLE `index_chunks`
  ADD CONSTRAINT `index_chunks_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `index_chunks_doc_id_fkey` FOREIGN KEY (`doc_id`) REFERENCES `documents` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `notifications`
--
ALTER TABLE `notifications`
  ADD CONSTRAINT `notifications_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `otps`
--
ALTER TABLE `otps`
  ADD CONSTRAINT `otps_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

--
-- Constraints for table `runs`
--
ALTER TABLE `runs`
  ADD CONSTRAINT `runs_case_id_fkey` FOREIGN KEY (`case_id`) REFERENCES `cases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;
COMMIT;

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
