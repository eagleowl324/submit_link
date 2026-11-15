// 제출 현황을 엑셀에서 바로 열리는 CSV로 만듭니다.

// 학생이 쓴 글이 =, +, -, @ 로 시작하면 엑셀이 수식으로 실행할 수 있어서 앞에 ' 를 붙입니다.
const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value) {
  let cell = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell)) cell = `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

// 맨 앞의 BOM(\uFEFF)이 있어야 엑셀이 한글을 깨뜨리지 않고 엽니다.
export function toCsv(rows) {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function submissionTable({ submissions, missing }, formatTime) {
  const rows = [['학번', '이름', '상태', '링크', '메모', '제출 시각', '처음 제출한 시각', '제출 횟수']];
  for (const s of submissions) {
    rows.push([
      s.studentId,
      s.name,
      s.isLate ? '지각' : '제출',
      s.url,
      s.note,
      formatTime(s.updatedAt),
      formatTime(s.createdAt),
      s.revision,
    ]);
  }
  for (const student of missing) {
    rows.push([student.studentId, student.name, '미제출', '', '', '', '', 0]);
  }
  return rows;
}
