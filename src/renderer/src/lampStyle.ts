// Reflux 의 Lamp enum 이름 → 화면 표시 이름 + 색상
//
// IIDX 의 표준 클리어 램프 색상을 따름:
//   FullCombo: 청록 / ExHard: 금 / Hard: 빨강 / Clear: 검정 / Easy: 초록
//   Assist: 보라 / Failed: 어두운 빨강 / NP: 회색
import type { Lamp } from '../../shared/types';

export interface LampStyle {
  label: string;
  color: string;
  bg: string;
}

export function lampStyle(lamp: Lamp): LampStyle {
  switch (lamp) {
    case 'PFC':
      return { label: 'P-FC', color: '#00d4dd', bg: '#e0f7f9' };
    case 'FC':
      return { label: 'F-COMBO', color: '#00aab2', bg: '#e6fafa' };
    case 'EX':
      return { label: 'EX-HARD', color: '#dcaf45', bg: '#fff8e6' };
    case 'HC':
      return { label: 'H-CLEAR', color: '#dc3545', bg: '#fbe9eb' };
    case 'NC':
      return { label: 'CLEAR', color: '#666', bg: '#f0f0f0' };
    case 'EC':
      return { label: 'E-CLEAR', color: '#52a447', bg: '#eaf6e8' };
    case 'AC':
      return { label: 'A-CLEAR', color: '#9966cc', bg: '#f3edfa' };
    case 'F':
      return { label: 'FAILED', color: '#8b3a3a', bg: '#f8eaea' };
    case 'NP':
      return { label: 'NO PLAY', color: '#aaa', bg: '#f5f5f5' };
    default:
      return { label: lamp || '-', color: '#888', bg: '#f5f5f5' };
  }
}

// Letter (DJ Level) 에 색상
export function letterColor(letter: string): string {
  switch (letter) {
    case 'AAA':
    case 'AA':
      return '#dcaf45';
    case 'A':
      return '#52a447';
    case 'B':
      return '#1971c2';
    case 'C':
    case 'D':
      return '#888';
    case 'E':
    case 'F':
      return '#dc3545';
    default:
      return '#aaa';
  }
}
