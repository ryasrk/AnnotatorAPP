"""
Database connection and schema initialization.
"""

import contextlib
import sqlite3
from config import DB_PATH


def get_db():
    db = sqlite3.connect(str(DB_PATH))
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA foreign_keys=ON")
    return db


@contextlib.contextmanager
def get_db_ctx():
    """Context-managed database connection. Auto-closes on exit."""
    db = get_db()
    try:
        yield db
    finally:
        db.close()


def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT,
            color TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS rooms (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            images_dir TEXT DEFAULT '',
            labels_dir TEXT DEFAULT '',
            export_dir TEXT DEFAULT '',
            folder_mode TEXT DEFAULT 'images_labels',
            is_private INTEGER DEFAULT 0,
            created_by INTEGER REFERENCES users(id),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER REFERENCES rooms(id),
            user_id INTEGER REFERENCES users(id),
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_by INTEGER REFERENCES users(id),
            resolved_at TIMESTAMP,
            UNIQUE(room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS room_members (
            room_id INTEGER REFERENCES rooms(id),
            user_id INTEGER REFERENCES users(id),
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (room_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS image_edits (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER,
            image_name TEXT NOT NULL,
            user_id INTEGER REFERENCES users(id),
            edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_edits_room_image
            ON image_edits(room_id, image_name);
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER REFERENCES rooms(id),
            sender_id INTEGER REFERENCES users(id),
            recipient_id INTEGER REFERENCES users(id),
            message TEXT NOT NULL,
            msg_type TEXT DEFAULT 'global',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_messages_room
            ON messages(room_id, created_at);
        CREATE TABLE IF NOT EXISTS room_classes (
            room_id INTEGER REFERENCES rooms(id),
            class_index INTEGER NOT NULL,
            class_name TEXT NOT NULL,
            PRIMARY KEY (room_id, class_index)
        );
        CREATE TABLE IF NOT EXISTS image_assignments (
            room_id INTEGER REFERENCES rooms(id),
            image_name TEXT NOT NULL,
            user_id INTEGER REFERENCES users(id),
            assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (room_id, image_name)
        );
        CREATE TABLE IF NOT EXISTS image_reviews (
            room_id INTEGER REFERENCES rooms(id),
            image_name TEXT NOT NULL,
            status TEXT DEFAULT 'pending',
            reviewer_id INTEGER REFERENCES users(id),
            reviewed_at TIMESTAMP,
            comment TEXT DEFAULT '',
            PRIMARY KEY (room_id, image_name)
        );
    """)
    db.commit()

    # Add columns/tables that may not exist in older databases
    _safe_alter(db, "ALTER TABLE rooms ADD COLUMN is_private INTEGER DEFAULT 0")
    _safe_alter(db, """
        CREATE TABLE IF NOT EXISTS join_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER REFERENCES rooms(id),
            user_id INTEGER REFERENCES users(id),
            status TEXT DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            resolved_by INTEGER REFERENCES users(id),
            resolved_at TIMESTAMP,
            UNIQUE(room_id, user_id)
        )
    """)

    db.close()
    print("[DB] Initialized")


def _safe_alter(db, sql):
    """Run ALTER TABLE or CREATE IF NOT EXISTS, ignoring 'already exists' errors."""
    try:
        db.execute(sql)
        db.commit()
    except sqlite3.OperationalError:
        pass
