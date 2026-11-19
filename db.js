const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const dbPath = path.join(__dirname, 'checkpoint.db');
const db = new Database(dbPath);

// Enforce foreign key constraints for relational integrity
db.pragma('foreign_keys = ON');

// Initialize schema from ARCHITECTURE.md
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('student', 'instructor')),
    session_token TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS exams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    duration_min INTEGER NOT NULL,
    max_violations INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT NOT NULL,
    option_d TEXT NOT NULL,
    correct TEXT NOT NULL CHECK(correct IN ('a', 'b', 'c', 'd'))
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    status TEXT DEFAULT 'in_progress',
    score REAL,
    question_order TEXT, -- JSON array of question IDs
    answers TEXT,        -- JSON object { questionId: selectedOption }
    risk_score INTEGER DEFAULT 0,
    risk_level TEXT DEFAULT 'LOW' CHECK(risk_level IN ('LOW', 'MEDIUM', 'HIGH')),
    reviewed INTEGER DEFAULT 0,
    review_note TEXT,
    appeal TEXT
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    details TEXT,        -- JSON object with metadata
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Ensure review_note and appeal columns exist on attempts table
try {
  db.exec('ALTER TABLE attempts ADD COLUMN review_note TEXT;');
} catch (e) {
  // Column already present
}
try {
  db.exec('ALTER TABLE attempts ADD COLUMN appeal TEXT;');
} catch (e) {
  // Column already present
}

// Seed initial users and sample exam if not already present
function seedData() {
  const userCount = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  if (userCount === 0) {
    const insertUser = db.prepare(`
      INSERT INTO users (name, email, password_hash, role)
      VALUES (@name, @email, @password_hash, @role)
    `);

    // 1 instructor (instructor@test.com / admin123)
    // Security: Passwords are salted and hashed with bcrypt to prevent credential exposure
    insertUser.run({
      name: 'Instructor',
      email: 'instructor@test.com',
      password_hash: bcrypt.hashSync('admin123', 10),
      role: 'instructor'
    });

    // 3 students (password: pass123)
    const students = [
      { name: 'Student 1', email: 'student1@test.com' },
      { name: 'Student 2', email: 'student2@test.com' },
      { name: 'Student 3', email: 'student3@test.com' }
    ];

    for (const student of students) {
      insertUser.run({
        name: student.name,
        email: student.email,
        password_hash: bcrypt.hashSync('pass123', 10),
        role: 'student'
      });
    }
  }

  const examCount = db.prepare('SELECT COUNT(*) AS count FROM exams').get().count;
  if (examCount === 0) {
    const insertExam = db.prepare(`
      INSERT INTO exams (title, duration_min, max_violations)
      VALUES (?, ?, ?)
    `);

    const result = insertExam.run('Sample Exam', 10, 5);
    const examId = result.lastInsertRowid;

    // 10 multiple-choice general-knowledge questions
    const sampleQuestions = [
      {
        text: 'What is the capital city of France?',
        option_a: 'Paris',
        option_b: 'London',
        option_c: 'Rome',
        option_d: 'Berlin',
        correct: 'a'
      },
      {
        text: 'Which planet is known as the Red Planet?',
        option_a: 'Venus',
        option_b: 'Mars',
        option_c: 'Jupiter',
        option_d: 'Saturn',
        correct: 'b'
      },
      {
        text: 'What is the largest ocean on Earth?',
        option_a: 'Atlantic Ocean',
        option_b: 'Indian Ocean',
        option_c: 'Arctic Ocean',
        option_d: 'Pacific Ocean',
        correct: 'd'
      },
      {
        text: 'Who painted the Mona Lisa?',
        option_a: 'Vincent van Gogh',
        option_b: 'Pablo Picasso',
        option_c: 'Leonardo da Vinci',
        option_d: 'Michelangelo',
        correct: 'c'
      },
      {
        text: 'What is the chemical symbol for gold?',
        option_a: 'Au',
        option_b: 'Ag',
        option_c: 'Fe',
        option_d: 'Pb',
        correct: 'a'
      },
      {
        text: 'In which year did Apollo 11 land on the moon?',
        option_a: '1965',
        option_b: '1969',
        option_c: '1972',
        option_d: '1975',
        correct: 'b'
      },
      {
        text: 'Which chemical element has the atomic number 1?',
        option_a: 'Helium',
        option_b: 'Oxygen',
        option_c: 'Hydrogen',
        option_d: 'Carbon',
        correct: 'c'
      },
      {
        text: 'What is the hardest natural substance on Earth?',
        option_a: 'Gold',
        option_b: 'Iron',
        option_c: 'Diamond',
        option_d: 'Platinum',
        correct: 'c'
      },
      {
        text: 'How many continents are there on Earth?',
        option_a: '5',
        option_b: '6',
        option_c: '7',
        option_d: '8',
        correct: 'c'
      },
      {
        text: 'What is the currency of Japan?',
        option_a: 'Yuan',
        option_b: 'Won',
        option_c: 'Yen',
        option_d: 'Ringgit',
        correct: 'c'
      }
    ];

    const insertQuestion = db.prepare(`
      INSERT INTO questions (exam_id, text, option_a, option_b, option_c, option_d, correct)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = db.transaction((questions) => {
      for (const q of questions) {
        insertQuestion.run(examId, q.text, q.option_a, q.option_b, q.option_c, q.option_d, q.correct);
      }
    });

    insertMany(sampleQuestions);
  }
}

seedData();

module.exports = db;
