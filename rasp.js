const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
require('dotenv').config();

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('Токен бота не задан в .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const API_BASE = 'https://digital.etu.ru/api/mobile';

// состояние в памяти
const userState = {};

// клавиатуры
const mainKeyboard = {
  reply_markup: {
    resize_keyboard: true,
    keyboard: [
      ['📍 Ближайшая пара'],
      ['📅 Сегодня', '📅 Завтра'],
      ['📘 Вся неделя'],
      ['📆 День недели'],
      ['🔄 Сменить группу']
    ]
  }
};

const weekKeyboard = {
  reply_markup: {
    resize_keyboard: true,
    keyboard: [
      ['Чётная неделя', 'Нечётная неделя'],
      ['<< Назад']
    ]
  }
};

const daysKeyboard = {
  reply_markup: {
    resize_keyboard: true,
    keyboard: [
      ['Понедельник', 'Вторник', 'Среда'],
      ['Четверг', 'Пятница', 'Суббота'],
      ['<< Назад']
    ]
  }
};

const DAYS = ['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];

/* --------------------- ВСПОМОГАТЕЛЬНЫЕ --------------------- */

function isLikelyGroupFormat(s) {
  return /^\d{4}$/.test(s);
}

function jsDayToIndex(jsDay) {
  // JS: 0=Sunday -> want 0=Monday -> (day+6)%7
  return (jsDay + 6) % 7;
}

function timeToMin(t) {
  if (!t || typeof t !== 'string') return 0;
  const parts = t.split(':').map(x => parseInt(x,10));
  if (parts.length < 2 || isNaN(parts[0])) return 0;
  return parts[0]*60 + (isNaN(parts[1])?0:parts[1]);
}

// Получение московского времени (UTC+3)
function getMoscowTime() {
  const now = new Date();
  // Москва UTC+3 (3 часа * 60 минут * 60 секунд * 1000 миллисекунд)
  return new Date(now.getTime() + 3 * 60 * 60 * 1000);
}

// Форматирование времени
function formatTime(date) {
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  return `${hours}:${minutes}`;
}

function formatDate(date) {
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month}`;
}

function formatFutureDate(date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);
  
  const diffTime = target - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays === 1) return 'Завтра';
  if (diffDays === 2) return 'Послезавтра';
  
  const day = target.getDate().toString().padStart(2, '0');
  const month = (target.getMonth() + 1).toString().padStart(2, '0');
  return `${day}.${month}`;
}

// вычисление чётности недели: 1 = нечётная, 2 = чётная
function getWeekTypeForDate(date) {
  // если задан SEMESTER_START, считаем от него
  if (process.env.SEMESTER_START) {
    const start = new Date(process.env.SEMESTER_START + 'T00:00:00');
    if (!isNaN(start.getTime())) {
      const diffDays = Math.floor((date - start) / 86400000);
      if (diffDays >= 0) {
        const weekIndex = Math.floor(diffDays / 7);
        return (weekIndex % 2 === 0) ? 1 : 2;
      }
    }
  }
  // fallback: ISO-week parity (1 odd, 2 even)
  const tmp = new Date(date.getTime());
  tmp.setHours(0,0,0,0);
  tmp.setDate(tmp.getDate() + 3 - ((tmp.getDay() + 6) % 7));
  const week1 = new Date(tmp.getFullYear(), 0, 4);
  const weekNumber = 1 + Math.round(((tmp.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return (weekNumber % 2 === 1) ? 1 : 2;
}

/* --------------------- API ВЗАИМОДЕЙСТВИЕ --------------------- */

async function fetchSchedule(group) {
  // Возвращаем объект расписания для группы (или бросаем ошибку)
  try {
    const res = await axios.get(`${API_BASE}/schedule`, {
      params: { groupNumber: group },
      timeout: 10000
    });
    if (!res.data || Object.keys(res.data).length === 0) {
      throw new Error('Пустой ответ от API');
    }
    // если есть ключ с именем группы — используем его
    if (res.data[group]) return res.data[group];
    // иначе возвращаем первый объект в ответе
    const firstKey = Object.keys(res.data)[0];
    return res.data[firstKey];
  } catch (err) {
    // пробрасываем дальше с содержательной информацией
    const msg = err.response && err.response.status ? `HTTP ${err.response.status}` : err.message;
    throw new Error(`Не удалось получить расписание: ${msg}`);
  }
}

async function verifyGroupExists(group) {
  // Проверяет существование группы, по сути вызывает fetchSchedule и ловит ошибку
  try {
    await fetchSchedule(group);
    return true;
  } catch (e) {
    return false;
  }
}

/* --------------------- ФИЛЬТРАЦИЯ/ФОРМАТ --------------------- */

function filterByWeek(lessons, weekType) {
  if (!Array.isArray(lessons)) return [];
  return lessons.filter(l => {
    if (!l.week && !l.weeks) return true; // если поле отсутствует — считается на все недели
    // API может содержать разные формы: week: "1", "2", "1/2", "вся"
    const wRaw = (l.week || l.weeks || '').toString().toLowerCase();
    if (!wRaw) return true;
    if (wRaw.includes('вся') || wRaw.includes('all') || wRaw.includes('1/2')) return true;
    // найти цифру 1 или 2 в строке
    const found = wRaw.match(/[12]/);
    if (!found) return true;
    return found[0] === String(weekType);
  });
}

function formatLesson(l) {
  const time = `${l.start_time || '??:??'}–${l.end_time || '??:??'}`;
  const type = l.subjectType ? `${l.subjectType}: ` : '';
  const name = l.name || l.subject || '—';
  const teacher = l.teacher ? `Преподаватель: ${l.teacher}` : 'Преподаватель: —';
  const room = l.room ? `Аудитория: ${l.room}` : 'Аудитория: —';
  return `${time}  ${type}${name}\n${teacher}\n${room}`;
}

/* --------------------- ОТПРАВКА/ЛОГИКА --------------------- */

async function sendMenu(chatId) {
  await bot.sendMessage(chatId, 'Выберите команду:', mainKeyboard);
}

// sendDay: если showMenu=false — меню не присылается (используется для сборки всей недели)
async function sendDay(chatId, dayIndex, weekType, showMenu = true) {
  const state = userState[chatId];
  if (!state || !state.group) {
    await bot.sendMessage(chatId, 'Сначала укажи номер группы');
    if (showMenu) await sendMenu(chatId);
    return;
  }

  try {
    const sched = await fetchSchedule(state.group);
    const day = sched.days && sched.days[String(dayIndex)];
    if (!day || !day.lessons || day.lessons.length === 0) {
      await bot.sendMessage(chatId, `${DAYS[dayIndex]}: пар нет`);
      if (showMenu) await sendMenu(chatId);
      return;
    }

    const lessons = filterByWeek(day.lessons, weekType);
    if (!lessons.length) {
      await bot.sendMessage(chatId, `${DAYS[dayIndex]}: пар нет (для выбранной недели)`);
      if (showMenu) await sendMenu(chatId);
      return;
    }

    const text = `— ${DAYS[dayIndex]} (${weekType === 1 ? 'нечётная' : 'чётная'} неделя)\n\n` +
      lessons.map(formatLesson).join('\n\n');

    await bot.sendMessage(chatId, text);

    // сброс выбранного дня (если был)
    delete state.selectedDay;

    if (showMenu) await sendMenu(chatId);
  } catch (e) {
    console.error('sendDay error', e);
    await bot.sendMessage(chatId, 'Ошибка получения данных расписания.');
    if (showMenu) await sendMenu(chatId);
  }
}

async function sendWeek(chatId, weekType) {
  const state = userState[chatId];
  if (!state || !state.group) {
    await bot.sendMessage(chatId, 'Сначала укажи номер группы');
    await sendMenu(chatId);
    return;
  }

  try {
    // отправляем все дни (Mon..Sun)
    for (let i = 0; i < 6; i++) {
      // sendDay with showMenu = false to avoid menu after each day
      await sendDay(chatId, i, weekType, false);
    }
    // one final menu
    await sendMenu(chatId);
  } catch (e) {
    console.error('sendWeek error', e);
    await bot.sendMessage(chatId, 'Ошибка получения расписания на неделю.');
    await sendMenu(chatId);
  }
}

async function sendNearestLesson(chatId) {
  const state = userState[chatId];
  if (!state || !state.group) {
    await bot.sendMessage(chatId, 'Сначала укажи номер группы');
    await sendMenu(chatId);
    return;
  }

  try {
    const sched = await fetchSchedule(state.group);
    const nowMoscow = getMoscowTime();
    const nowHours = nowMoscow.getHours();
    const nowMinutes = nowMoscow.getMinutes();
    const nowTotalMinutes = nowHours * 60 + nowMinutes;

    // Ищем ближайшую пару в течение 7 дней
    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const targetDate = new Date(nowMoscow);
      targetDate.setDate(nowMoscow.getDate() + dayOffset);
      targetDate.setHours(0, 0, 0, 0);
      
      const dayIndex = jsDayToIndex(targetDate.getDay());
      const weekType = getWeekTypeForDate(targetDate);

      const day = sched.days && sched.days[String(dayIndex)];
      if (!day || !day.lessons || day.lessons.length === 0) continue;

      const lessons = filterByWeek(day.lessons, weekType)
        .sort((a, b) => timeToMin(a.start_time) - timeToMin(b.start_time));
      
      if (!lessons.length) continue;

      for (const lesson of lessons) {
        const startTime = lesson.start_time || "00:00";
        const endTime = lesson.end_time || "23:59";
        
        const [startHour, startMinute] = startTime.split(':').map(Number);
        const [endHour, endMinute] = endTime.split(':').map(Number);
        
        const startTotalMinutes = startHour * 60 + startMinute;
        const endTotalMinutes = endHour * 60 + endMinute;
        
        // Если это сегодня
        if (dayOffset === 0) {
          // Пара уже закончилась - пропускаем
          if (endTotalMinutes < nowTotalMinutes) {
            continue;
          }
          
          // Пара идет прямо сейчас
          if (startTotalMinutes <= nowTotalMinutes && nowTotalMinutes < endTotalMinutes) {
            const minutesPassed = nowTotalMinutes - startTotalMinutes;
            const totalDuration = endTotalMinutes - startTotalMinutes;
            const minutesLeft = endTotalMinutes - nowTotalMinutes;
            
            text = `📍 Текущая пара (сейчас)\n${formatDate(targetDate)}, ${DAYS[dayIndex]}\n${startTime}–${endTime}  ${lesson.subjectType ? lesson.subjectType : ''}: ${lesson.name || lesson.subject || 'Без названия'}\nПреподаватель: ${lesson.teacher || '—'}\nАудитория: ${lesson.room || '—'}`;
            await bot.sendMessage(chatId, text);
            return await sendMenu(chatId);
          }
          
          // Пара будет позже сегодня
          if (startTotalMinutes > nowTotalMinutes) {
            const minutesLeft = startTotalMinutes - nowTotalMinutes;
            const text = `📍 Ближайшая пара\nСегодня, ${DAYS[dayIndex]}\n${startTime}–${endTime} (через ${minutesLeft} мин.)\n${lesson.subjectType ? lesson.subjectType : ''}: ${lesson.name || lesson.subject || 'Без названия'}\nПреподаватель: ${lesson.teacher || '—'}\nАудитория: ${lesson.room || '—'}`;
            await bot.sendMessage(chatId, text);
            return await sendMenu(chatId);
          }
        } else {
          // Если это будущий день, берем первую пару
          const text = `📍 Ближайшая пара \n${formatFutureDate(targetDate)}, ${DAYS[dayIndex]}\n${startTime}–${endTime}  ${lesson.subjectType ? lesson.subjectType : ''}: ${lesson.name || lesson.subject || 'Без названия'}\nПреподаватель: ${lesson.teacher || '—'}\nАудитория: ${lesson.room || '—'}`;
          await bot.sendMessage(chatId, text);
          return await sendMenu(chatId);
        }
      }
    }

    await bot.sendMessage(chatId, 'Пар не найдено в ближайшую неделю');
    await sendMenu(chatId);
  } catch (error) {
    console.error('Ошибка поиска ближайшей пары:', error);
    await bot.sendMessage(chatId, 'Ошибка при поиске ближайшей пары. Попробуйте позже.');
    await sendMenu(chatId);
  }
}

/* --------------------- ОБРАБОТЧИКИ --------------------- */

// /start - просим ввести группу
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  userState[chatId] = {}; // сброс
  bot.sendMessage(chatId, 'Здравствуй, лэтишник... Введи свой роковой номер группы:');
});

// обработка любых текстовых сообщений (включая нажатия reply-кнопок)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text && msg.text.trim();
  if (!text) return;

  // Игнорируем команды /start и пр. (они обработаны отдельно)
  if (text.startsWith('/')) {
    return;
  }

  // Если пользователь нажал "Сменить группу" — сбрасываем состояние и просим ввести
  if (text === '🔄 Сменить группу') {
    userState[chatId] = {};
    await bot.sendMessage(chatId, 'Введи новый номер группы:');
    return;
  }

  // Если у пользователя ещё нет сохранённой группы — воспринимаем текcт как номер группы
  if (!userState[chatId] || !userState[chatId].group) {
    const candidate = text;
    // проверка формата
    if (!isLikelyGroupFormat(candidate)) {
      await bot.sendMessage(chatId, 'Неверный формат номера группы. Номер должен содержать 4 цифры. Введите снова:');
      return;
    }
    // проверка существования группы через API
    await bot.sendMessage(chatId, `Проверяю группу ${candidate}...`);
    const exists = await verifyGroupExists(candidate);
    if (!exists) {
      await bot.sendMessage(chatId, `Группа "${candidate}" не найдена. Проверь номер и введи ещё раз:`);
      return;
    }
    // всё ок — сохраняем
    userState[chatId] = { group: candidate };
    await bot.sendMessage(chatId, `✅ Группа сохранена: ${candidate}`);
    return sendMenu(chatId);
  }

  // далее — обработка команд/кнопок, когда группа уже указана
  try {
    // выбор дня — показать клавиатуру дней
    if (text === '📆 День недели') {
      return bot.sendMessage(chatId, 'Выбери день:', daysKeyboard);
    }

    // выбор всех недель (показываем клавиатуру для чёт/нечёт)
    if (text === '📘 Вся неделя') {
      // помечаем, что запрос на "всю неделю" (если нужно - можно хранить флаг)
      userState[chatId].selectedDay = undefined;
      return bot.sendMessage(chatId, 'Выбери тип недели для расписания на всю неделю:', weekKeyboard);
    }

    // ближайшая пара
    if (text === '📍 Ближайшая пара') {
      return sendNearestLesson(chatId);
    }

    // сегодня / завтра
    if (text === '📅 Сегодня') {
      return sendDay(chatId, jsDayToIndex(new Date().getDay()), getWeekTypeForDate(new Date()));
    }
    if (text === '📅 Завтра') {
      const t = new Date(); t.setDate(t.getDate() + 1);
      return sendDay(chatId, jsDayToIndex(t.getDay()), getWeekTypeForDate(t));
    }

    // пользователь выбрал конкретный день (reply-кнопка)
    if (DAYS.includes(text)) {
      userState[chatId].selectedDay = DAYS.indexOf(text);
      return bot.sendMessage(chatId, `Выбран ${text}. Теперь выбери тип недели:`, weekKeyboard);
    }

    // выбор чётной/нечётной недели (для "вся неделя" или для ранее выбранного дня)
    if (text === 'Чётная неделя' || text === 'Нечётная неделя') {
      const weekType = text.startsWith('Чёт') ? 2 : 1;
      const state = userState[chatId];

      if (typeof state.selectedDay === 'number') {
        // выбран конкретный день — выводим только его
        return sendDay(chatId, state.selectedDay, weekType, true);
      } else {
        // не выбран день — выводим всю неделю (Mon..Sun)
        return sendWeek(chatId, weekType);
      }
    }

    // "Назад" кнопка
    if (text === '<< Назад') {
      return sendMenu(chatId);
    }

    // если текст не распознан — показываем подсказку
    await bot.sendMessage(chatId, 'Неизвестная команда. Выбери действие:', mainKeyboard);
  } catch (e) {
    console.error('message handler error', e);
    await bot.sendMessage(chatId, 'Произошла ошибка. Попробуйте снова.');
    await sendMenu(chatId);
  }
});

const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req,res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`HTTP server listening on port ${PORT}`));

console.log('Успешный запуск бота!!!');
